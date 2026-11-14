import { RedisMemoryServer } from 'redis-memory-server';

export interface TestRedis {
  url: string;
  host: string;
  port: number;
  stop(): Promise<void>;
}

/**
 * A real Redis server for tests, with no Docker. `redis-memory-server` downloads the Redis source
 * and compiles it once (needs `make` and a C compiler); the binary is cached and reused.
 * Set REDISMS_SYSTEM_BINARY to use an installed `redis-server` instead.
 */
export async function startTestRedis(): Promise<TestRedis> {
  const server = new RedisMemoryServer();
  await server.start();
  const host = await server.getHost();
  const port = await server.getPort();
  return {
    url: `redis://${host}:${port}`,
    host,
    port,
    stop: async () => void (await server.stop()),
  };
}
