// `pnpm stack`: the whole system on this machine, in one command.
//
//   KAFKA_HOME=/path/to/kafka_2.13-3.9.0 pnpm stack          (or KAFKA_BROKERS=host:9092 for a broker you run)
//   pnpm stack -- --no-web      only the backend
//   pnpm stack -- --no-seed     skip the demo shows
//   pnpm stack -- --observability   also Grafana dashboard, Prometheus and Jaeger traces
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PORTS, startStack } from './stack';

// Settings kept out of git (Google sign-in keys, ...) come from a .env file in the repo root.
// Variables already set in the shell win. Only this command reads it, never the tests.
const dotenv = join(__dirname, '..', '..', '.env');
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const stripe = !!process.env.STRIPE_SECRET_KEY;
  if (stripe && !process.env.STRIPE_PUBLISHABLE_KEY)
    throw new Error('STRIPE_PUBLISHABLE_KEY is missing from .env');
  const google = !!process.env.GOOGLE_CLIENT_ID;
  if (google) {
    process.env.GOOGLE_REDIRECT_URI ??= `http://127.0.0.1:${PORTS.web}/api/auth/google/callback`;
    if (!process.env.GOOGLE_CLIENT_SECRET)
      throw new Error('GOOGLE_CLIENT_SECRET is missing from .env');
  }
  const stack = await startStack({
    web: !args.has('--no-web'),
    seed: !args.has('--no-seed'),
    observability: args.has('--observability'),
    stripe,
  });
  console.log(`
Gatepass is running.

  App          http://127.0.0.1:${PORTS.web}        (open this; sign in with Google if .env has the keys, or as a demo user)
  Gateway API  ${stack.urls.gateway}
  Dashboard    ${stack.urls.grafana ?? '(start with --observability for Grafana, Prometheus, Jaeger)'}
  Traces       ${stack.urls.jaeger ?? '-'}
  Logs         ${stack.logDir}

  Demo shows: Neon Nights Live (waiting room), The Laugh Lab, Campus Fest Finale, Midnight Market, and
  Jazz on the Roof (sold out). Payments use the FAKE provider unless .env has Stripe test keys
  (then use card 4242 4242 4242 4242; 4000 0000 0000 0002 is declined).
  Sign in as "Organizer" to see sales and approve refunds; as "Door staff" to scan tickets.

Press Ctrl-C to stop everything.`);
  const shutdown = () => void stack.stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('could not start the stack:', err);
  process.exit(1);
});
