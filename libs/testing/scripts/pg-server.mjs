// Runs a throwaway Postgres (embedded-postgres is ESM-only, so it lives in its own process).
// Usage: node pg-server.mjs <dataDir> <port> <password>   Prints READY once accepting connections.
import EmbeddedPostgres from 'embedded-postgres';

const [dir, port, password] = process.argv.slice(2);
const server = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'postgres',
  password,
  port: Number(port),
  persistent: false,
  postgresFlags: ['-c', 'max_connections=200', '-c', 'fsync=off'],
  onLog: () => {},
  onError: () => {},
});

const shutdown = async () => {
  try {
    await server.stop();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('disconnect', shutdown);

await server.initialise();
await server.start();
console.log('READY');
setInterval(() => {}, 1 << 30);
