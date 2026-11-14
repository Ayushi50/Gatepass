import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { CatalogClient } from '../clients/clients';
import { InvalidTokenError, verifyAdmissionToken } from '../auth/jwt';
import { JWT_SECRET } from '../auth/auth.guard';
import { WaitingRoom } from './waiting-room';

export const ADMISSION_CATALOG = Symbol('ADMISSION_CATALOG');

export type AdmissionRefusal = 'waiting_room_required' | 'admission_invalid' | 'admission_expired';

const refuse = (code: AdmissionRefusal, message: string) =>
  new ForbiddenException({ statusCode: 403, code, message });

/**
 * The gate in front of POST /api/bookings. A show marked high-demand needs a waiting-room
 * admission: a token signed by us, for THIS user and THIS show, that is also still alive in Redis
 * (so it ends when the admission ends). Other shows pass straight through.
 */
@Injectable()
export class AdmissionGate {
  private readonly cache = new Map<string, { waitingRoom: boolean; until: number }>();

  constructor(
    @Inject(ADMISSION_CATALOG) private readonly catalog: CatalogClient,
    @Inject(JWT_SECRET) private readonly secret: string,
    private readonly room: WaitingRoom,
  ) {}

  /** Does this show use the waiting room? (cached briefly: it changes rarely, and we are the hot path) */
  async required(eventId: string): Promise<boolean> {
    const hit = this.cache.get(eventId);
    if (hit && hit.until > Date.now()) return hit.waitingRoom;
    const event = await this.catalog.getEvent(eventId);
    this.cache.set(eventId, { waitingRoom: event.waitingRoom, until: Date.now() + 5000 });
    return event.waitingRoom;
  }

  async check(eventId: string, userId: string, token: string | undefined): Promise<void> {
    if (!(await this.required(eventId))) return;
    if (!token) throw refuse('waiting_room_required', 'this show uses the waiting room');
    let claims;
    try {
      claims = verifyAdmissionToken(token, this.secret);
    } catch (err) {
      if (err instanceof InvalidTokenError) {
        throw refuse(
          err.message === 'token expired' ? 'admission_expired' : 'admission_invalid',
          err.message,
        );
      }
      throw err;
    }
    if (claims.sub !== userId || claims.evt !== eventId) {
      throw refuse('admission_invalid', 'this admission is not for you or not for this show');
    }
    if (!(await this.room.isAdmitted(eventId, userId))) {
      throw refuse('admission_expired', 'your admission has ended');
    }
  }
}
