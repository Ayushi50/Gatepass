import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InvalidTokenError, verifyToken, type Claims, type Role } from './jwt';

export const JWT_SECRET = Symbol('JWT_SECRET');
const ROLES_KEY = 'roles';

/** Requires a valid token whose role is one of `roles`. Routes without it are public. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: Claims;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(JWT_SECRET) private readonly secret: string,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.get<Role[] | undefined>(ROLES_KEY, context.getHandler());
    if (!roles) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    if (!value?.startsWith('Bearer ')) throw new UnauthorizedException('missing bearer token');

    let claims: Claims;
    try {
      claims = verifyToken(value.slice('Bearer '.length), this.secret);
    } catch (err) {
      if (err instanceof InvalidTokenError) throw new UnauthorizedException(err.message);
      throw err;
    }
    if (!roles.includes(claims.role)) throw new ForbiddenException('role not allowed');
    req.user = claims;
    return true;
  }
}
