import { checkReadiness, mountReadiness } from '../src';

describe('readiness (F-06)', () => {
  it('is ready when every dependency answers', async () => {
    const r = await checkReadiness('demo', { postgres: async () => 1, kafka: async () => 2 });
    expect(r.ready).toBe(true);
    expect(r.body).toEqual({
      status: 'ready',
      service: 'demo',
      checks: { postgres: 'ok', kafka: 'ok' },
    });
  });

  it('is not ready when one fails, names it, and hides the error text', async () => {
    const r = await checkReadiness('demo', {
      postgres: async () => 1,
      kafka: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:9092 password=hunter2');
      },
    });
    expect(r.ready).toBe(false);
    expect(r.body.checks).toEqual({ postgres: 'ok', kafka: 'failed' });
    expect(JSON.stringify(r.body)).not.toMatch(/hunter2|10\.0\.0\.5/);
  });

  it('counts a hung dependency as failed instead of hanging the probe', async () => {
    const r = await checkReadiness('demo', { redis: () => new Promise(() => undefined) }, 50);
    expect(r.body.checks).toEqual({ redis: 'failed' });
  });

  it('GET /ready answers 200 or 503', async () => {
    const routes = new Map<string, (req: unknown, res: unknown) => unknown>();
    const app = {
      getHttpAdapter: () => ({
        get: (p: string, h: (req: unknown, res: unknown) => unknown) => void routes.set(p, h),
      }),
    };
    let down = false;
    mountReadiness(app, 'demo', {
      db: async () => {
        if (down) throw new Error('x');
      },
    });
    const call = async () => {
      const sent: { status?: number; body?: string } = {};
      const res = {
        statusCode: 0,
        setHeader: () => undefined,
        end: (b?: string) => void ((sent.status = res.statusCode), (sent.body = b)),
      };
      await routes.get('/ready')!({}, res);
      return sent;
    };
    expect((await call()).status).toBe(200);
    down = true;
    const bad = await call();
    expect(bad.status).toBe(503);
    expect(JSON.parse(bad.body!).status).toBe('not ready');
  });
});
