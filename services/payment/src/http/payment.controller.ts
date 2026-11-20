import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  IdempotencyConflictError,
  PayableNotFoundError,
  PaymentConflictError,
  PaymentValidationError,
  ProviderUnavailableError,
  confirmCheckout,
  handleWebhook,
  startPayment,
  type PaymentDeps,
  type StartPaymentInput,
} from '../payments';
import { InvalidSignatureError } from '../providers/provider';

export const DEPS = Symbol('PAYMENT_DEPS');

interface RawRequest {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

/** Internal API: `/payments` is called by the gateway; `/webhooks/:provider` by the provider. */
@Controller()
export class PaymentController {
  constructor(@Inject(DEPS) private readonly deps: PaymentDeps) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'payment' };
  }

  /** The buyer finished in the provider's window; the gateway passes on what the page brought back. */
  @Post('payments/confirm')
  @HttpCode(200)
  async confirm(
    @Body()
    body: {
      bookingId?: string;
      userId?: string;
      orderId?: string;
      paymentRef?: string;
      signature?: string;
    },
  ) {
    try {
      return await confirmCheckout(this.deps, {
        bookingId: String(body?.bookingId ?? ''),
        userId: String(body?.userId ?? ''),
        orderId: String(body?.orderId ?? ''),
        paymentRef: String(body?.paymentRef ?? ''),
        signature: String(body?.signature ?? ''),
      });
    } catch (err) {
      if (err instanceof InvalidSignatureError) throw new BadRequestException('invalid signature');
      if (err instanceof PaymentValidationError) throw new BadRequestException(err.message);
      if (err instanceof PayableNotFoundError) throw new NotFoundException(err.message);
      if (err instanceof PaymentConflictError)
        throw new ConflictException({ message: err.message, code: err.code });
      throw err;
    }
  }

  @Post('payments')
  @HttpCode(202)
  async pay(@Body() body: StartPaymentInput) {
    try {
      return await startPayment(this.deps, {
        bookingId: body?.bookingId,
        userId: body?.userId,
        method: body?.method,
        token: body?.token,
        idempotencyKey: body?.idempotencyKey,
      });
    } catch (err) {
      if (err instanceof PaymentValidationError) throw new BadRequestException(err.message);
      if (err instanceof IdempotencyConflictError)
        throw new UnprocessableEntityException(err.message);
      if (err instanceof PayableNotFoundError) throw new NotFoundException(err.message);
      if (err instanceof PaymentConflictError) {
        throw new ConflictException({ message: err.message, code: err.code });
      }
      if (err instanceof ProviderUnavailableError)
        throw new ServiceUnavailableException(err.message);
      throw err;
    }
  }

  /**
   * Provider callbacks. The signature is checked over the RAW body, so Nest must keep it
   * (`rawBody: true`). Anything authentic is acknowledged with 200 so the provider stops
   * retrying, including duplicates and events we deliberately ignore.
   */
  @Post('webhooks/:provider')
  @HttpCode(200)
  async webhook(@Param('provider') provider: string, @Req() req: RawRequest) {
    if (provider !== this.deps.provider.name) throw new NotFoundException('unknown provider');
    if (!req.rawBody) throw new BadRequestException('missing body');
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers))
      headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    try {
      return { result: await handleWebhook(this.deps, req.rawBody, headers) };
    } catch (err) {
      if (err instanceof InvalidSignatureError) throw new BadRequestException('invalid signature');
      throw err;
    }
  }
}
