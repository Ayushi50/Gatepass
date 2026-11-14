import {
  Controller,
  ConflictException,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, JWT_SECRET, Roles, type AuthedRequest } from '../auth/auth.guard';
import { signAdmissionToken } from '../auth/jwt';
import { AdmissionGate } from '../waiting-room/admission';
import { WaitingRoom, type WaitingRoomStatus } from '../waiting-room/waiting-room';
import { relay } from './downstream';

/** What the waiting-room page needs: place in line, estimated wait, and the pass once let in. */
export type WaitingRoomView =
  | { state: 'waiting'; position: number; estimatedWaitSeconds: number }
  | { state: 'admitted'; admissionToken: string; expiresInSeconds: number }
  | { state: 'not_queued' };

@Controller('api')
@UseGuards(AuthGuard)
export class WaitingRoomController {
  constructor(
    private readonly room: WaitingRoom,
    private readonly gate: AdmissionGate,
    @Inject(JWT_SECRET) private readonly secret: string,
  ) {}

  private view(eventId: string, userId: string, s: WaitingRoomStatus): WaitingRoomView {
    if (s.state !== 'admitted') return s;
    // the pass ends exactly when the admission does
    const admissionToken = signAdmissionToken({ sub: userId, eventId }, this.secret, {
      ttlSeconds: s.expiresInSeconds,
    });
    return { state: 'admitted', admissionToken, expiresInSeconds: s.expiresInSeconds };
  }

  private async mustUseWaitingRoom(eventId: string): Promise<void> {
    const needed = await relay(() => this.gate.required(eventId));
    if (!needed)
      throw new ConflictException({
        code: 'waiting_room_not_required',
        message: 'this show has no waiting room',
      });
  }

  /** Join the queue. Safe to repeat: you keep your place. */
  @Post('events/:id/waiting-room/join')
  @Roles('attendee')
  @HttpCode(200)
  async join(@Req() req: AuthedRequest, @Param('id') id: string): Promise<WaitingRoomView> {
    await this.mustUseWaitingRoom(id);
    return this.view(id, req.user!.sub, await this.room.join(id, req.user!.sub));
  }

  /** Where am I? Poll this; once `admitted`, it carries the pass for POST /api/bookings. */
  @Get('events/:id/waiting-room')
  @Roles('attendee')
  async status(@Req() req: AuthedRequest, @Param('id') id: string): Promise<WaitingRoomView> {
    await this.mustUseWaitingRoom(id);
    return this.view(id, req.user!.sub, await this.room.status(id, req.user!.sub));
  }
}
