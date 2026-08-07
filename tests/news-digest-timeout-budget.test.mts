import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';
import {
  __resetFetcherTimeoutForTests,
  __setFetcherTimeoutForTests,
  cachedFetchJson,
  REDIS_OP_TIMEOUT_MS,
  REDIS_PIPELINE_TIMEOUT_MS,
} from '../server/_shared/redis';

const {
  VERCEL_INITIAL_RESPONSE_LIMIT_MS,
  DIGEST_RESPONSE_TIMEOUT_MS,
  POST_FETCH_HEADROOM_MS,
  RESPONSE_GUARD_BAND_MS,
  OVERALL_DEADLINE_MS,
  mapSettledWithConcurrency,
  isAuthorizedDigestRefresh,
  DIGEST_CACHE_TTL_S,
} = __testing__;

const DIGEST_SRC = readFileSync(
  new URL('../server/worldmonitor/news/v1/list-feed-digest.ts', import.meta.url),
  'utf8',
);

function jsonResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    async json() {
      return payload;
    },
  } as Response;
}

function withEnv(overrides: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function isRedisSet(init: RequestInit | undefined): boolean {
  try {
    const body = JSON.parse(String(init?.body ?? 'null'));
    return Array.isArray(body) && body[0] === 'SET';
  } catch {
    return false;
  }
}

describe('news digest timeout budget', () => {
  it('retains last-known-good data beyond the health freshness window', () => {
    assert.ok(
      DIGEST_CACHE_TTL_S > 10 * 60,
      'complete digest TTL must outlive the 10-minute Vantage health freshness window',
    );
  });

  it('only allows the dedicated scheduler secret to force a digest rebuild', async () => {
    const restoreEnv = withEnv({ WORLDMONITOR_RELAY_KEY: 'scheduler-secret' });
    try {
      assert.equal(await isAuthorizedDigestRefresh(new Request(
        'https://vantage-osint.vercel.app/api/news/v1/list-feed-digest?refresh=123',
      )), false);
      assert.equal(await isAuthorizedDigestRefresh(new Request(
        'https://vantage-osint.vercel.app/api/news/v1/list-feed-digest?refresh=123',
        { headers: { 'X-WorldMonitor-Key': 'wrong-secret' } },
      )), false);
      assert.equal(await isAuthorizedDigestRefresh(new Request(
        'https://vantage-osint.vercel.app/api/news/v1/list-feed-digest',
        { headers: { 'X-WorldMonitor-Key': 'scheduler-secret' } },
      )), false);
      assert.equal(await isAuthorizedDigestRefresh(new Request(
        'https://vantage-osint.vercel.app/api/news/v1/list-feed-digest?refresh=123',
        { headers: { 'X-WorldMonitor-Key': 'scheduler-secret' } },
      )), true);
    } finally {
      restoreEnv();
    }
  });

  it('keeps cold cache misses below Vercel initial-response timeout', () => {
    assert.equal(VERCEL_INITIAL_RESPONSE_LIMIT_MS, 25_000);
    assert.ok(
      RESPONSE_GUARD_BAND_MS >= 3_000,
      'fallback path must reserve several seconds for edge runtime overhead and response jitter',
    );
    assert.ok(
      REDIS_OP_TIMEOUT_MS + DIGEST_RESPONSE_TIMEOUT_MS + REDIS_PIPELINE_TIMEOUT_MS + RESPONSE_GUARD_BAND_MS
        < VERCEL_INITIAL_RESPONSE_LIMIT_MS,
      'cache read + digest timeout + Redis sentinel write must leave platform response headroom',
    );
    assert.ok(
      REDIS_OP_TIMEOUT_MS + OVERALL_DEADLINE_MS + REDIS_PIPELINE_TIMEOUT_MS + RESPONSE_GUARD_BAND_MS
        < VERCEL_INITIAL_RESPONSE_LIMIT_MS,
      'RSS collection plus cache write must leave platform response headroom',
    );
    assert.ok(
      OVERALL_DEADLINE_MS + RESPONSE_GUARD_BAND_MS < DIGEST_RESPONSE_TIMEOUT_MS,
      'RSS collection deadline must leave assembly room before the cache miss response timeout',
    );
  });

  it('passes the digest-specific timeout to cachedFetchJson', () => {
    assert.match(
      DIGEST_SRC,
      /cachedFetchJson<ListFeedDigestResponse>\([\s\S]*\{\s*timeoutMs:\s*DIGEST_RESPONSE_TIMEOUT_MS\s*\}\s*,\s*\)/,
      'listFeedDigest must not rely on cachedFetchJson default timeout for cold builds',
    );
  });

  it('starts later feeds as soon as a concurrency slot is free', async () => {
    const controller = new AbortController();
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    let releaseSlow: (() => void) | undefined;

    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const run = mapSettledWithConcurrency(
      ['slow', 'fast-1', 'fast-2', 'fast-3'],
      2,
      controller.signal,
      async (entry) => {
        started.push(entry);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (entry === 'slow') await slow;
        active -= 1;
        return entry;
      },
    );

    // Let the immediately-resolving worker drain the later fast entries. A
    // fixed-size batch would still be waiting for `slow` and would not have
    // started fast-2 or fast-3 yet.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ['slow', 'fast-1', 'fast-2', 'fast-3']);
    assert.equal(maxActive, 2, 'worker pool must preserve the concurrency ceiling');

    releaseSlow?.();
    const settled = await run;
    assert.deepEqual(
      settled.map((result) => result?.status),
      ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'],
    );
  });

  it('proves cachedFetchJson waits for the post-timeout sentinel write', async () => {
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let releaseSet: (() => void) | undefined;
    let setCalls = 0;
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (isRedisSet(init)) {
        setCalls += 1;
        await new Promise<void>((resolve) => {
          releaseSet = resolve;
        });
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      __setFetcherTimeoutForTests(10);
      let settled = false;
      const result = cachedFetchJson(
        'news:digest:timeout-budget',
        60,
        () => new Promise<never>(() => {}),
      ).catch((err: unknown) => err).finally(() => {
        settled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(setCalls, 1, 'timeout path should attempt the negative sentinel write');
      assert.equal(settled, false, 'cachedFetchJson must still be waiting on the sentinel write');

      releaseSet?.();
      const err = await result;
      assert.match(
        err instanceof Error ? err.message : String(err),
        /^cachedFetchJson timeout after 10ms for "news:digest:timeout-budget"$/,
      );
    } finally {
      releaseSet?.();
      __resetFetcherTimeoutForTests();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});
