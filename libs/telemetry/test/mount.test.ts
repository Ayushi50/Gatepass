import { mountTelemetry } from '../src';

describe('mountTelemetry', () => {
  it('gives every service GET /metrics and a GET /health that says it is alive', async () => {
    const routes = new Map<string, (req: unknown, res: unknown) => unknown>();
    const app = {
      use: () => undefined,
      getHttpAdapter: () => ({
        get: (p: string, h: (req: unknown, res: unknown) => unknown) => void routes.set(p, h),
      }),
    };
    mountTelemetry(app, 'demo');
    expect([...routes.keys()].sort()).toEqual(['/health', '/metrics']);

    const sent: { status?: number; type?: string; body?: string } = {};
    const res = {
      statusCode: 200,
      setHeader: (k: string, v: string) => void (k === 'content-type' && (sent.type = v)),
      status(code: number) {
        sent.status = code;
        return res;
      },
      end: (b?: string) => void (sent.body = b),
      on: () => undefined,
    };
    routes.get('/health')!({}, res);
    expect(JSON.parse(sent.body!)).toEqual({ status: 'ok', service: 'demo' });
    expect(sent.type).toContain('application/json');
  });
});
