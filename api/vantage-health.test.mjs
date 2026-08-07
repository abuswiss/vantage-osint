import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  classifyCacheEntry,
  collectVantageHealth,
  relayHealthUrl,
  summarizeRelayHealth,
  default: handler,
} = await import('./vantage-health.js');

describe('Vantage public health', () => {
  it('classifies cache presence without exposing payload data', () => {
    const now = Date.parse('2026-08-07T12:00:00.000Z');
    assert.deepEqual(
      classifyCacheEntry({ result: JSON.stringify({ generatedAt: '2026-08-07T11:58:00.000Z' }) }, 10 * 60_000, now),
      { status: 'ready', ageSeconds: 120 },
    );
    assert.deepEqual(classifyCacheEntry({ result: null }, 10 * 60_000, now), {
      status: 'missing',
      ageSeconds: null,
    });
  });

  it('normalizes websocket relay URLs and projects only operational state', () => {
    assert.equal(relayHealthUrl('wss://relay.example.com/socket?secret=nope'), 'https://relay.example.com/health');
    assert.deepEqual(summarizeRelayHealth({
      status: 'ok',
      ingestion: {
        status: 'ok',
        aviation: { coverage: { status: 'ok' } },
        aisSnapshot: { connected: true },
      },
    }), { status: 'ready', air: 'ready', ships: 'ready' });
  });

  it('reports a ready end-to-end data plane', async () => {
    const now = Date.parse('2026-08-07T12:00:00.000Z');
    const health = await collectVantageHealth({
      pipeline: async () => [
        { result: 'PONG' },
        { result: JSON.stringify({ generatedAt: '2026-08-07T11:59:00.000Z' }) },
        { result: JSON.stringify({ generatedAt: '2026-08-07T11:50:00.000Z' }) },
        { result: JSON.stringify({ fetchedAt: '2026-08-07T11:50:00.000Z' }) },
      ],
      fetch: async () => new Response(JSON.stringify({
        status: 'ok',
        ingestion: {
          status: 'ok',
          aviation: { coverage: { status: 'ok' } },
          aisSnapshot: { connected: true },
        },
      })),
      env: { WS_RELAY_URL: 'wss://relay.example.com' },
    }, now);

    assert.equal(health.status, 'ready');
    assert.deepEqual(health.services.relay, { status: 'ready', air: 'ready', ships: 'ready' });
    assert.equal(JSON.stringify(health).includes('relay.example.com'), false);
  });

  it('is public, no-store, and fails readiness when Redis is unavailable', async () => {
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    try {
      const response = await handler(new Request('https://vantage-osint.vercel.app/api/vantage-health'));
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    } finally {
      if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    }
  });
});
