import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, Roles, type AuthedRequest } from '../auth/auth.guard';
import type { TicketClient } from '../clients/clients';
import { relay } from './downstream';

export const TICKETS = Symbol('TICKETS');

@Controller('api')
@UseGuards(AuthGuard)
export class TicketsController {
  constructor(@Inject(TICKETS) private readonly tickets: TicketClient) {}

  /** The signed-in attendee's own tickets, each with its QR token. */
  @Get('tickets')
  @Roles('attendee')
  list(@Req() req: AuthedRequest) {
    return relay(() => this.tickets.list(req.user!.sub));
  }

  /**
   * "Request a refund" (design/tickets.html). The ticket is locked at once (it will no longer scan)
   * and the organizer is asked to approve. 404 if it is not yours, 409 if it cannot be refunded.
   */
  @Post('tickets/:id/refund')
  @Roles('attendee')
  @HttpCode(202)
  requestRefund(@Req() req: AuthedRequest, @Param('id') id: string) {
    return relay(() => this.tickets.requestRefund(id, req.user!.sub));
  }

  /**
   * The door scanner. Door staff only. A scan is a normal question with three normal answers:
   * 200 `valid`, 409 `used` (with `usedAt`), 404 `invalid`. The gates may call this at the
   * same time for the same QR; the ticket service guarantees only one is admitted.
   */
  @Post('checkin')
  @Roles('door-staff')
  async checkIn(
    @Req() req: AuthedRequest,
    @Body() body: { qrToken?: string },
    @Res({ passthrough: true }) res: { status(code: number): unknown },
  ) {
    if (!body?.qrToken || typeof body.qrToken !== 'string' || body.qrToken.length > 2048) {
      throw new BadRequestException('qrToken is required');
    }
    const answer = await relay(() => this.tickets.checkIn(body.qrToken as string, req.user!.sub));
    res.status(answer.httpStatus);
    return answer.body;
  }
}
