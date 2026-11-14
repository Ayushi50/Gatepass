/** @type {import('next').NextConfig} */
const gateway = process.env.GATEWAY_URL ?? 'http://127.0.0.1:3000';

export default {
  reactStrictMode: true,
  // SSE must not be buffered or compressed on its way through the proxy
  compress: false,
  devIndicators: false,
  poweredByHeader: false,
  async rewrites() {
    // The browser only ever talks to this origin; /api is proxied to the gateway (so: no CORS).
    return [{ source: '/api/:path*', destination: `${gateway}/api/:path*` }];
  },
};
