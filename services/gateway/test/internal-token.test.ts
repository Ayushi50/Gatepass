import { createServer, type Server } from 'node:http';
import { internalAuth } from '@gatepass/telemetry';
import { HttpBookingClient, HttpTicketClient } from '../src/clients/clients';

const TOKEN = 'g'.repeat(40);

describe('gateway -> internal service token (F-04)', () => {
  let server: Server;
  let base: string;
  const guard = internalAuth(TOKEN);

  beforeAll(async () => {
    server = createServer((req, res) => {
      guard(
        { url: req.url!, headers: req.headers },
        {
          get statusCode() {
            return res.statusCode;
          },
          set statusCode(v: number) {
            res.statusCode = v;
          },
          setHeader: (k, v) => void res.setHeader(k, v),
          end: (b) => void res.end(b),
        },
        () => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, status: 'valid' }));
        },
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  afterEach(() => delete process.env.INTERNAL_TOKEN);

  it('is accepted when the gateway sends the shared token (JSON calls and check-in)', async () => {
    process.env.INTERNAL_TOKEN = TOKEN;
    await expect(new HttpBookingClient(base).get('b1')).resolves.toMatchObject({ ok: true });
    await expect(new HttpTicketClient(base).checkIn('qr', 'staff')).resolves.toMatchObject({
      httpStatus: 200,
    });
  });

  it('is refused when the token is missing or wrong', async () => {
    await expect(new HttpBookingClient(base).get('b1')).rejects.toMatchObject({ status: 401 });
    process.env.INTERNAL_TOKEN = 'w'.repeat(40);
    await expect(new HttpBookingClient(base).get('b1')).rejects.toMatchObject({ status: 401 });
  });
});
