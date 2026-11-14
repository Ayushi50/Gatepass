import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { JWT_SECRET } from '../auth/auth.guard';
import { ROLES, signToken, type Role } from '../auth/jwt';

export const DEV_LOGIN = Symbol('DEV_LOGIN');

/** The organizer who owns the demo shows; the seed publishes them under this id. */
export const DEMO_ORGANIZER = 'org-demo';

const NAME = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/**
 * DEMO SIGN-IN. There are no real accounts yet, so the web app needs some way to hold a token.
 * This mints one for a demo user, and exists ONLY when ENABLE_DEV_LOGIN=true and NODE_ENV is not
 * "production" (main.ts decides); otherwise the route does not exist (404).
 */
@Controller('api')
export class DevLoginController {
  constructor(
    @Inject(DEV_LOGIN) private readonly enabled: boolean,
    @Inject(JWT_SECRET) private readonly secret: string,
  ) {}

  @Post('dev-login')
  @HttpCode(200)
  login(@Body() body: { role?: string; name?: string }) {
    if (!this.enabled) throw new NotFoundException();
    const role = body?.role as Role;
    if (!ROLES.includes(role))
      throw new BadRequestException(`role must be one of ${ROLES.join(', ')}`);

    let sub: string;
    if (role === 'organizer') sub = DEMO_ORGANIZER;
    else if (role === 'door-staff') sub = 'staff-1';
    else if (body?.name === undefined || body.name === '') sub = 'attendee-1';
    else {
      const name = String(body.name).trim().toLowerCase();
      if (!NAME.test(name))
        throw new BadRequestException('name must be 2-32 letters, digits, - or _');
      sub = name;
    }
    return { token: signToken({ sub, role }, this.secret, { ttlSeconds: 8 * 3600 }), sub, role };
  }
}
