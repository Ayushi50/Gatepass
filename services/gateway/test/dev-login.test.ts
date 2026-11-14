import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ActivityStreamHub,
  BookingStreamHub,
  GatewayModule,
  SeatStreamHub,
  WaitingRoom,
  verifyToken,
  type GatewayOptions,
} from '../src';

const SECRET = 'a-test-secret-that-is-long-enough-123';

async function appWith(devLogin: boolean | undefined): Promise<INestApplication> {
  const stub = {} as never;
  const options: GatewayOptions = {
    catalog: stub,
    inventory: stub,
    bookings: stub,
    payments: stub,
    tickets: stub,
    analytics: stub,
    hub: new SeatStreamHub(),
    bookingHub: new BookingStreamHub(),
    activityHub: new ActivityStreamHub(),
    waitingRoom: new WaitingRoom({} as never, { admitPerSecond: 5, admissionTtlSeconds: 300 }),
    jwtSecret: SECRET,
    devLogin,
  };
  const mod = await Test.createTestingModule({
    imports: [GatewayModule.forRoot(options)],
  }).compile();
  const app = mod.createNestApplication();
  await app.init();
  return app;
}

describe('POST /api/dev-login', () => {
  it('does not exist unless it was switched on', async () => {
    for (const flag of [undefined, false]) {
      const app = await appWith(flag);
      await request(app.getHttpServer())
        .post('/api/dev-login')
        .send({ role: 'attendee' })
        .expect(404);
      await app.close();
    }
  });

  describe('when switched on', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await appWith(true);
    });
    afterAll(async () => {
      await app.close();
    });
    const login = (body: object) => request(app.getHttpServer()).post('/api/dev-login').send(body);

    it('mints a token for each role that the gateway itself accepts', async () => {
      for (const [role, sub] of [
        ['attendee', 'attendee-1'],
        ['organizer', 'org-demo'],
        ['door-staff', 'staff-1'],
      ] as const) {
        const res = await login({ role }).expect(200);
        expect(res.body).toMatchObject({ role, sub });
        expect(verifyToken(res.body.token, SECRET)).toMatchObject({ role, sub });
      }
    });

    it('lets an attendee choose a name, so two browsers can be two people', async () => {
      const res = await login({ role: 'attendee', name: ' Aarav ' }).expect(200);
      expect(res.body.sub).toBe('aarav');
    });

    it('the organizer is always the demo organizer, whatever name is sent', async () => {
      expect((await login({ role: 'organizer', name: 'someone-else' }).expect(200)).body.sub).toBe(
        'org-demo',
      );
    });

    it('refuses unknown roles and unusable names', async () => {
      await login({ role: 'admin' }).expect(400);
      await login({}).expect(400);
      await login({ role: 'attendee', name: 'x' }).expect(400);
      await login({ role: 'attendee', name: 'has spaces' }).expect(400);
      await login({ role: 'attendee', name: '../../etc' }).expect(400);
    });

    it('a minted token is a real login: it opens the attendee routes and not the organizer ones', async () => {
      const { body } = await login({ role: 'attendee' });
      await request(app.getHttpServer())
        .get('/api/tickets')
        .set('Authorization', `Bearer ${body.token}`)
        .expect(500); // passes auth; the stub client then fails
      await request(app.getHttpServer())
        .get('/api/organizer/events/x/summary')
        .set('Authorization', `Bearer ${body.token}`)
        .expect(403);
    });
  });
});
