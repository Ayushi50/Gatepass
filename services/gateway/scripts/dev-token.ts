// Prints a development JWT. Usage: pnpm --filter @gatepass/gateway dev-token <role> <userId>
// Reads JWT_SECRET from the environment, like the gateway does.
import { ROLES, signToken, type Role } from '../src/auth/jwt';

const [role = 'attendee', sub = 'dev-user'] = process.argv.slice(2);
const secret = process.env.JWT_SECRET;
if (!secret) throw new Error('set JWT_SECRET (same value as the gateway)');
if (!ROLES.includes(role as Role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
console.log(signToken({ sub, role: role as Role }, secret, { ttlSeconds: 8 * 3600 }));
