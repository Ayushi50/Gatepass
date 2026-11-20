import { Controller, Get, Inject } from '@nestjs/common';

export type PaymentsConfig = { provider: 'fake' } | { provider: 'razorpay'; keyId: string };
export const PAYMENTS_CONFIG = Symbol('PAYMENTS_CONFIG');

/** Tells the checkout page which payment provider is live. Publishable keys are public by design. */
@Controller('api/payments')
export class PaymentsConfigController {
  constructor(@Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig) {}

  @Get('config')
  get(): PaymentsConfig {
    return this.config;
  }
}
