/* eslint-disable no-console */
// `pnpm stack`: the whole system on this machine, in one command.
//
//   KAFKA_HOME=/path/to/kafka_2.13-3.9.0 pnpm stack          (or KAFKA_BROKERS=host:9092 for a broker you run)
//   pnpm stack -- --no-web      only the backend
//   pnpm stack -- --no-seed     skip the demo shows
import { PORTS, startStack } from './stack';

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const stack = await startStack({ web: !args.has('--no-web'), seed: !args.has('--no-seed') });
  console.log(`
Gatepass is running.

  App          http://127.0.0.1:${PORTS.web}        (open this; "Continue" signs you in as a demo user)
  Gateway API  ${stack.urls.gateway}
  Logs         ${stack.logDir}

  Demo shows: Neon Nights Live (waiting room), The Laugh Lab, Campus Fest Finale, Midnight Market, and
  Jazz on the Roof (sold out). Payments use the FAKE provider and complete by themselves; a card
  number of 4000 0000 0000 0002 (or a UPI id ending @fail) is declined.
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
