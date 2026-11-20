import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Optional,
  Query,
  Req,
  Res,
} from '@nestjs/common';

/** The little of Express this controller touches (the gateway does not depend on express directly). */
interface Req {
  headers: { cookie?: string };
}
interface Res {
  setHeader(name: string, value: string): void;
  redirect(status: number, url: string): void;
}
import { GOOGLE, GOOGLE_COOKIE, GoogleAuth, SignInError } from '../auth/google';
import { DEV_LOGIN } from './dev-login.controller';

@Controller('api/auth')
export class GoogleAuthController {
  constructor(
    @Optional() @Inject(GOOGLE) private readonly google: GoogleAuth | null,
    @Inject(DEV_LOGIN) private readonly demo: boolean,
  ) {}

  /** Which sign-in methods this server offers, so the sign-in page shows the right buttons. */
  @Get('config')
  config() {
    return { google: !!this.google, demo: this.demo };
  }

  @Get('google/start')
  start(
    @Query('next') next: string | undefined,
    @Query('role') role: string | undefined,
    @Res() res: Res,
  ) {
    if (!this.google) throw new NotFoundException();
    const { location, cookie } = this.google.start(next, role);
    res.setHeader('Set-Cookie', cookie);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, location);
  }

  @Get('google/callback')
  async callback(
    @Query() q: { code?: string; state?: string; error?: string },
    @Req() req: Req,
    @Res() res: Res,
  ) {
    if (!this.google) throw new NotFoundException();
    res.setHeader('Cache-Control', 'no-store');
    // the cookie has done its job either way
    res.setHeader('Set-Cookie', `${GOOGLE_COOKIE}=; Max-Age=0; Path=/api/auth/google`);
    const cookie = /(?:^|;\s*)gp_oauth=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    try {
      const { token, next } = await this.google.finish({ ...q, cookie });
      // in the fragment, so the token never reaches a server log or a Referer header
      const frag = new URLSearchParams({ token, ...(next ? { next } : {}) });
      res.redirect(302, `/sign-in#${frag}`);
    } catch (err) {
      const code = err instanceof SignInError ? err.message : 'failed';
      if (!(err instanceof SignInError))
        console.error('[gateway] google sign-in:', (err as Error).message);
      res.redirect(302, `/sign-in?error=${code}`);
    }
  }
}
