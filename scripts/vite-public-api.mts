import type { Plugin } from 'vite';

// Vite does not execute file-based API routes. Keep this explicit: arbitrary
// api files (including refresh jobs and administrative writes) stay unexposed.
const PUBLIC_READ_ROUTES = new Map([
  ['/api/vantage-bootstrap', '/api/vantage-bootstrap.js'],
  ['/api/vantage-health', '/api/vantage-health.js'],
  ['/api/health', '/api/health.js'],
  ['/api/correlation-runtime-mode', '/api/correlation-runtime-mode.js'],
]);

export function publicApiPlugin(): Plugin {
  return {
    name: 'public-read-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', `http://localhost:${server.config.server.port ?? 5173}`);
        const modulePath = PUBLIC_READ_ROUTES.get(url.pathname);
        if (!modulePath) return next();
        if (req.method !== 'GET' && req.method !== 'OPTIONS') {
          res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, OPTIONS' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          }
          const request = new Request(url, { method: req.method, headers });
          const module = await server.ssrLoadModule(modulePath);
          // Support both Edge functions and Vercel's Node { fetch } export.
          const response: Response = typeof module.default === 'function'
            ? await module.default(request)
            : await module.default.fetch(request);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(await response.text());
        } catch (error) {
          server.config.logger.error(`[public-read-api] ${url.pathname}: ${String(error)}`);
          res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: 'Service temporarily unavailable' }));
        }
      });
    },
  };
}
