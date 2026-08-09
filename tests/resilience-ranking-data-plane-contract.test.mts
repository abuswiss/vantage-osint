import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { mapErrorToResponse } from '../server/error-mapper.ts';
import { getResilienceRanking } from '../server/worldmonitor/resilience/v1/get-resilience-ranking.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalVantageMode = process.env.VANTAGE_PUBLIC_MODE;
const originalViteVantageMode = process.env.VITE_VANTAGE_PUBLIC_MODE;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restore('UPSTASH_REDIS_REST_URL', originalRedisUrl);
  restore('UPSTASH_REDIS_REST_TOKEN', originalRedisToken);
  restore('VANTAGE_PUBLIC_MODE', originalVantageMode);
  restore('VITE_VANTAGE_PUBLIC_MODE', originalViteVantageMode);
});

describe('Vantage resilience ranking source-plane contract', () => {
  it('returns an explicit retryable 503 instead of a plausible-looking 0/0 ranking on an empty plane', async () => {
    process.env.VANTAGE_PUBLIC_MODE = 'true';
    delete process.env.VITE_VANTAGE_PUBLIC_MODE;
    installRedis({});

    let unavailableError: unknown;
    try {
      await getResilienceRanking(
        { request: new Request('https://vantage-osint.vercel.app/api/resilience/v1/get-resilience-ranking') } as never,
        {},
      );
      assert.fail('expected the empty Vantage source plane to fail closed');
    } catch (error) {
      unavailableError = error;
    }

    const apiError = unavailableError as {
      statusCode?: unknown;
      body?: unknown;
      retryAfter?: unknown;
      exposeMessage?: unknown;
    };
    assert.equal(apiError.statusCode, 503);
    assert.equal(JSON.parse(String(apiError.body)).code, 'RESILIENCE_DATA_UNAVAILABLE');
    assert.equal(apiError.retryAfter, 60);
    assert.equal(apiError.exposeMessage, true);

    const wireResponse = mapErrorToResponse(
      unavailableError,
      new Request('https://vantage-osint.vercel.app/api/resilience/v1/get-resilience-ranking'),
    );
    assert.equal(wireResponse.status, 503);
    assert.equal(wireResponse.headers.get('retry-after'), '60');
    assert.deepEqual(await wireResponse.json(), {
      message: 'Resilience data temporarily unavailable',
      code: 'RESILIENCE_DATA_UNAVAILABLE',
      retryAfter: 60,
    });
  });

  it('does not expose arbitrary 5xx codes, messages, or diagnostic bodies', async () => {
    const internalError = Object.assign(new Error('private upstream URL and token'), {
      statusCode: 503,
      body: 'redis://private.example?token=secret',
      publicCode: 'PRIVATE_UPSTREAM_FAILURE',
    });

    const response = mapErrorToResponse(
      internalError,
      new Request('https://vantage-osint.vercel.app/api/resilience/v1/get-resilience-ranking'),
    );
    const serialized = JSON.stringify(await response.json());

    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(serialized), { message: 'Internal server error' });
    assert.doesNotMatch(serialized, /private|token|redis|PRIVATE_UPSTREAM_FAILURE/i);
  });
});
