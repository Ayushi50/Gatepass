import { createServer, type Server } from 'node:http';
import { serveMetrics } from './http';
import { sendReadiness, type ReadinessChecks } from './ready';

/** A bare /metrics server for a worker with no HTTP API of its own (the notification service). */
export function startMetricsServer(port: number, ready?: ReadinessChecks): Server {
  return createServer((req, res) => {
    if (req.url?.startsWith('/metrics')) return void serveMetrics(res as never);
    if (req.url === '/ready' && ready)
      return void sendReadiness(res as never, 'notification', ready);
    if (req.url === '/health') return void res.writeHead(200).end('ok');
    res.writeHead(404).end();
  }).listen(port);
}
