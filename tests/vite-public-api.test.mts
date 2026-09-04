import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { publicApiPlugin } from '../scripts/vite-public-api.mts';

async function requestRoute(path: string, method: string, entry: unknown) {
  let middleware: Function | undefined;
  const loaded: string[] = [];
  const plugin = publicApiPlugin();
  assert.equal(typeof plugin.configureServer, 'function');
  if (typeof plugin.configureServer !== 'function') throw new Error('Missing configureServer');
  plugin.configureServer.call({} as never, {
    config: { server: { port: 5173 }, logger: { error() {} } },
    middlewares: { use(fn: Function) { middleware = fn; } },
    async ssrLoadModule(modulePath: string) { loaded.push(modulePath); return { default: entry }; },
  } as never);
  let next = false;
  let body = '';
  const headers: Record<string, string> = {};
  const response = {
    statusCode: 200,
    setHeader(key: string, value: string) { headers[key.toLowerCase()] = value; },
    writeHead(status: number, values: Record<string, string>) {
      this.statusCode = status;
      for (const [key, value] of Object.entries(values)) this.setHeader(key, value);
    },
    end(value = '') { body = value; },
  };
  assert.ok(middleware);
  await middleware({ url: path, method, headers: { origin: 'http://localhost:5173' } }, response, () => { next = true; });
  return { loaded, next, body, headers, status: response.statusCode };
}

describe('local public API routing', () => {
  it('executes Edge handlers and preserves a degraded JSON response', async () => {
    const result = await requestRoute('/api/vantage-health', 'GET', (req: Request) => {
      assert.equal(req.headers.get('origin'), 'http://localhost:5173');
      return Response.json({ status: 'unavailable' }, { status: 503 });
    });
    assert.deepEqual(result.loaded, ['/api/vantage-health.js']);
    assert.equal(result.status, 503);
    assert.deepEqual(JSON.parse(result.body), { status: 'unavailable' });
    assert.match(result.headers['content-type']!, /application\/json/);
  });

  it('executes the Node bootstrap fetch export with its query intact', async () => {
    const result = await requestRoute('/api/vantage-bootstrap?tier=fast&public=1', 'GET', {
      fetch(req: Request) {
        assert.equal(new URL(req.url).search, '?tier=fast&public=1');
        return Response.json({ data: { insights: {} }, missing: [] });
      },
    });
    assert.equal(result.status, 200);
    assert.ok(JSON.parse(result.body).data.insights);
  });

  it('does not expose jobs or arbitrary API modules', async () => {
    for (const path of ['/api/vantage-refresh', '/api/admin', '/api/vantage-health.js']) {
      const result = await requestRoute(path, 'GET', () => { throw new Error('Should not run'); });
      assert.equal(result.next, true);
      assert.deepEqual(result.loaded, []);
    }
  });

  it('rejects writes without loading the handler', async () => {
    const result = await requestRoute('/api/vantage-health', 'POST', () => { throw new Error('Should not run'); });
    assert.equal(result.status, 405);
    assert.equal(result.headers.allow, 'GET, OPTIONS');
    assert.deepEqual(result.loaded, []);
  });

  it('turns handler failures into JSON instead of a source or HTML response', async () => {
    const result = await requestRoute('/api/vantage-health', 'GET', () => { throw new Error('Upstream failed'); });
    assert.equal(result.status, 503);
    assert.equal(JSON.parse(result.body).error, 'Service temporarily unavailable');
  });
});
