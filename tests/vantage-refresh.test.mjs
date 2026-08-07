import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  config as functionConfig,
  handleVantageRefresh,
  runVantageRefresh,
  unwrapStoredInsights,
  VANTAGE_REFRESH_LIMITS,
  verifyInsightsSnapshot,
} from '../api/vantage-refresh.js';
import {
  decorateInsightsRun,
  seedInsightsOnce,
} from '../scripts/seed-insights.mjs';

const NOW_MS = Date.parse('2026-08-07T09:00:00.000Z');
const NOW_ISO = new Date(NOW_MS).toISOString();
const ENV = {
  CRON_SECRET: 'cron-test-secret',
  WORLDMONITOR_RELAY_KEY: 'relay-test-secret',
  UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
  UPSTASH_REDIS_REST_TOKEN: 'redis-test-token',
};

function responseRecorder() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body) {
      this.body = body;
    },
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function validInsights(overrides = {}, seedOverrides = {}) {
  return {
    seed: {
      fetchedAt: NOW_MS,
      recordCount: 1,
      sourceVersion: 'test',
      schemaVersion: 1,
      state: 'OK',
      ...seedOverrides,
    },
    payload: {
      status: 'ok',
      generatedAt: NOW_ISO,
      worldBrief: 'A corroborated test story remains material [1].',
      briefStoryLines: [{ n: 1, text: 'The cited source confirms the development [1].' }],
      topStories: [{ primaryTitle: 'A corroborated test story' }],
      worldBriefSources: [{ title: 'Source', source: 'Wire', url: 'https://example.test/story' }],
      briefProvider: 'openai',
      ...overrides,
    },
  };
}

describe('Vantage native cron contract', () => {
  it('pins a five-minute production cron and a bounded Node duration', () => {
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    const testWorkflow = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
    assert.deepEqual(vercel.crons, [{ path: '/api/vantage-refresh', schedule: '*/5 * * * *' }]);
    assert.equal(functionConfig.maxDuration, 300);
    assert.equal(functionConfig.runtime, undefined);
    assert.ok(VANTAGE_REFRESH_LIMITS.lockTtlMs > VANTAGE_REFRESH_LIMITS.maxDurationMs);
    assert.ok(VANTAGE_REFRESH_LIMITS.deadlineMs < VANTAGE_REFRESH_LIMITS.maxDurationMs);
    assert.match(testWorkflow, /-not -path "api\/vantage-refresh\.js"/);
    assert.match(
      testWorkflow,
      /esbuild api\/vantage-refresh\.js --bundle --format=esm --platform=node/,
    );
  });

  it('rejects non-GET and unauthenticated requests before orchestration', async () => {
    let calls = 0;
    const runVantageRefreshStub = async () => {
      calls += 1;
      return { status: 'ok' };
    };

    const postRes = responseRecorder();
    await handleVantageRefresh(
      { method: 'POST', headers: {} },
      postRes,
      { env: ENV, runVantageRefresh: runVantageRefreshStub },
    );
    assert.equal(postRes.statusCode, 405);

    const unauthorizedRes = responseRecorder();
    await handleVantageRefresh(
      { method: 'GET', headers: { authorization: 'Bearer wrong' } },
      unauthorizedRes,
      { env: ENV, runVantageRefresh: runVantageRefreshStub },
    );
    assert.equal(unauthorizedRes.statusCode, 401);
    assert.equal(calls, 0);
  });

  it('accepts the timing-safe cron bearer and returns no-store JSON', async () => {
    const res = responseRecorder();
    await handleVantageRefresh(
      { method: 'GET', headers: { authorization: `Bearer ${ENV.CRON_SECRET}` } },
      res,
      {
        env: ENV,
        runVantageRefresh: async () => ({ status: 'ok', news: { categoryCount: 17 } }),
      },
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(res.body), { status: 'ok', news: { categoryCount: 17 } });
  });

  it('sanitizes internal failures instead of returning configuration or secrets', async () => {
    const res = responseRecorder();
    const originalError = console.error;
    console.error = () => {};
    try {
      await handleVantageRefresh(
        { method: 'GET', headers: { authorization: `Bearer ${ENV.CRON_SECRET}` } },
        res,
        {
          env: ENV,
          runVantageRefresh: async () => {
            throw new Error(`provider failed with ${ENV.WORLDMONITOR_RELAY_KEY}`);
          },
        },
      );
    } finally {
      console.error = originalError;
    }
    assert.equal(res.statusCode, 500);
    assert.deepEqual(JSON.parse(res.body), { error: 'Refresh failed' });
    assert.doesNotMatch(res.body, /relay-test-secret/);
  });
});

describe('Vantage refresh orchestration', () => {
  it('refreshes news, risk, and a fresh cited brief under one Redis lock', async () => {
    const fetched = [];
    const released = [];
    let insightReads = 0;
    const result = await runVantageRefresh({
      env: ENV,
      now: () => NOW_MS,
      acquireLock: async () => ({ locked: true, skipped: false }),
      releaseLock: async (...args) => released.push(args),
      fetch: async (input, init) => {
        const url = String(input);
        fetched.push({ url, headers: init.headers });
        if (url.includes('/api/news/')) {
          return jsonResponse({
            generatedAt: NOW_ISO,
            categories: {
              world: { items: [{ title: 'One' }] },
              politics: { items: [{ title: 'Two' }] },
              technology: { items: [{ title: 'Three' }] },
            },
          });
        }
        if (url.includes('/api/intelligence/')) {
          return jsonResponse({ ciiScores: [{ countryCode: 'IR', score: 72 }] });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
      seedInsights: async () => ({ status: 'published' }),
      readInsights: async () => {
        insightReads += 1;
        return insightReads === 1
          ? validInsights(
              { generatedAt: '2026-08-07T08:00:00.000Z' },
              { fetchedAt: Date.parse('2026-08-07T08:00:00.000Z') },
            )
          : validInsights();
      },
      readRiskMeta: async () => ({ fetchedAt: NOW_MS }),
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.news.categoryCount, 3);
    assert.equal(result.news.itemCount, 3);
    assert.equal(result.risk.scoreCount, 1);
    assert.equal(result.insights.citationCount, 1);
    assert.equal(result.insights.seedStatus, 'published');
    assert.equal(fetched.length, 2);
    assert.match(fetched[0].url, /refresh=/);
    assert.equal(fetched[0].headers['X-WorldMonitor-Key'], ENV.WORLDMONITOR_RELAY_KEY);
    assert.equal(released.length, 1);
  });

  it('treats a concurrent invocation as an idempotent skip', async () => {
    let fetched = false;
    const result = await runVantageRefresh({
      env: ENV,
      now: () => NOW_MS,
      acquireLock: async () => ({ locked: false, skipped: false }),
      fetch: async () => {
        fetched = true;
        throw new Error('must not fetch');
      },
    });
    assert.deepEqual(result, { status: 'skipped', reason: 'already_running' });
    assert.equal(fetched, false);
  });

  it('uses one no-retry seed attempt and fails closed when cited insights remain stale', async () => {
    let seedCalls = 0;
    let releases = 0;
    await assert.rejects(
      runVantageRefresh({
        env: ENV,
        now: () => NOW_MS,
        acquireLock: async () => ({ locked: true, skipped: false }),
        releaseLock: async () => { releases += 1; },
        fetch: async (input) => String(input).includes('/api/news/')
          ? jsonResponse({
              generatedAt: NOW_ISO,
              categories: {
                world: { items: [{ title: 'One' }] },
                politics: { items: [{ title: 'Two' }] },
                technology: { items: [{ title: 'Three' }] },
              },
            })
          : jsonResponse({ ciiScores: [{ countryCode: 'IR', score: 72 }] }),
        seedInsights: async (seedDependencies) => {
          seedCalls += 1;
          let attempts = 0;
          await seedDependencies.withRetry(async () => { attempts += 1; });
          assert.equal(attempts, 1);
          return { status: 'preserved' };
        },
        readInsights: async () => validInsights(
          { generatedAt: '2026-08-07T08:00:00.000Z' },
          { fetchedAt: Date.parse('2026-08-07T08:00:00.000Z') },
        ),
        readRiskMeta: async () => ({ fetchedAt: NOW_MS }),
      }),
      /did not publish/,
    );
    assert.equal(seedCalls, 1);
    assert.equal(releases, 1);
  });

  it('keeps a citation-valid brief for fifteen minutes without another LLM call', async () => {
    let seedCalls = 0;
    const result = await runVantageRefresh({
      env: ENV,
      now: () => NOW_MS,
      acquireLock: async () => ({ locked: true, skipped: false }),
      releaseLock: async () => {},
      fetch: async (input) => String(input).includes('/api/news/')
        ? jsonResponse({
            generatedAt: NOW_ISO,
            categories: {
              world: { items: [{ title: 'One' }] },
              politics: { items: [{ title: 'Two' }] },
              technology: { items: [{ title: 'Three' }] },
            },
          })
        : jsonResponse({ ciiScores: [{ countryCode: 'IR', score: 72 }] }),
      readRiskMeta: async () => ({ fetchedAt: NOW_MS }),
      readInsights: async () => validInsights(),
      seedInsights: async () => { seedCalls += 1; },
    });
    assert.equal(seedCalls, 0);
    assert.equal(result.insights.seedStatus, 'not_due');
  });

  it('rejects empty news buckets and degraded risk snapshots', async () => {
    const base = {
      env: ENV,
      now: () => NOW_MS,
      acquireLock: async () => ({ locked: true, skipped: false }),
      releaseLock: async () => {},
      readRiskMeta: async () => ({ fetchedAt: NOW_MS }),
      readInsights: async () => validInsights(),
    };
    await assert.rejects(runVantageRefresh({
      ...base,
      fetch: async (input) => String(input).includes('/api/news/')
        ? jsonResponse({ generatedAt: NOW_ISO, categories: { a: {}, b: {}, c: {} } })
        : jsonResponse({ ciiScores: [{}] }),
    }), /no items/);
    await assert.rejects(runVantageRefresh({
      ...base,
      fetch: async (input) => String(input).includes('/api/news/')
        ? jsonResponse({
            generatedAt: NOW_ISO,
            categories: { a: { items: [{}] }, b: { items: [{}] }, c: { items: [{}] } },
          })
        : jsonResponse({ ciiScores: [{}], degraded: true, stale: true }),
    }), /degraded or stale/);
    await assert.rejects(runVantageRefresh({
      ...base,
      readRiskMeta: async () => ({ fetchedAt: NOW_MS - 16 * 60_000 }),
      fetch: async (input) => String(input).includes('/api/news/')
        ? jsonResponse({
            generatedAt: NOW_ISO,
            categories: { a: { items: [{}] }, b: { items: [{}] }, c: { items: [{}] } },
          })
        : jsonResponse({ ciiScores: [{}], degraded: false, stale: false }),
    }), /recent source snapshot/);
  });
});

describe('serverless insights publisher adapter', () => {
  it('publishes the canonical envelope and freshness metadata without exiting', async () => {
    const published = [];
    const released = [];
    const payload = decorateInsightsRun(validInsights().payload, { outcome: 'published' });
    const result = await seedInsightsOnce({
      now: () => NOW_MS,
      acquireLock: async () => ({ locked: true, skipped: false }),
      releaseLock: async (...args) => released.push(args),
      withRetry: async (fn) => fn(),
      fetchInsights: async () => payload,
      atomicPublish: async (...args) => {
        published.push(args);
        return { payloadBytes: 123 };
      },
      finalizeInsightsRun: async () => ({ freshnessMetaPatch: { lastSuccessAt: NOW_MS } }),
      writeFreshnessMetadataSafely: async () => ({ fetchedAt: NOW_MS }),
      verifySeedKey: async () => true,
      flushPendingLlmEvents: async () => {},
    });

    assert.equal(result.status, 'published');
    assert.equal(result.recordCount, 1);
    assert.equal(result.verified, true);
    assert.equal(published.length, 1);
    assert.equal(published[0][0], 'news:insights:v1');
    assert.equal(published[0][4].envelopeMeta.state, 'OK');
    assert.equal(released.length, 1);
  });

  it('preserves last-known-good data when strict synthesis gates reject a run', async () => {
    let publishCalls = 0;
    let preservedKeys = null;
    const payload = decorateInsightsRun(validInsights({ generatedAt: '2026-08-07T08:30:00.000Z' }).payload, {
      outcome: 'lkg_preserved',
      failureCode: 'INSIGHTS_SYNTHESIS_GATE',
    });
    const result = await seedInsightsOnce({
      now: () => NOW_MS,
      acquireLock: async () => ({ locked: true, skipped: false }),
      releaseLock: async () => {},
      withRetry: async (fn) => fn(),
      fetchInsights: async () => payload,
      atomicPublish: async () => { publishCalls += 1; },
      readExistingSeedMeta: async () => ({
        fetchedAt: NOW_MS - 30_000,
        recordCount: 1,
        sourceVersion: 'existing-version',
      }),
      readCanonicalEnvelopeMeta: async () => ({
        fetchedAt: NOW_MS - 30_000,
        recordCount: 1,
        sourceVersion: 'existing-version',
      }),
      extendExistingTtl: async (keys) => {
        preservedKeys = keys;
        return true;
      },
      finalizeInsightsRun: async () => ({ freshnessMetaPatch: { consecutiveFailures: 1 } }),
      writeFreshnessMetadataSafely: async () => ({ fetchedAt: NOW_MS - 30_000 }),
      flushPendingLlmEvents: async () => {},
    });

    assert.equal(result.status, 'preserved');
    assert.equal(result.reason, 'INSIGHTS_SYNTHESIS_GATE');
    assert.equal(publishCalls, 0);
    assert.ok(preservedKeys.includes('news:insights:v1'));
  });

  it('does not resurrect stale seed metadata when the canonical LKG envelope is gone', async () => {
    const writes = [];
    const payload = decorateInsightsRun(validInsights().payload, {
      outcome: 'lkg_preserved',
      failureCode: 'INSIGHTS_SYNTHESIS_GATE',
    });
    await assert.rejects(seedInsightsOnce({
      now: () => NOW_MS,
      acquireLock: async () => ({ locked: true, skipped: false }),
      releaseLock: async () => {},
      withRetry: async (fn) => fn(),
      fetchInsights: async () => payload,
      readExistingSeedMeta: async () => ({ fetchedAt: NOW_MS - 60_000, recordCount: 8 }),
      readCanonicalEnvelopeMeta: async () => null,
      extendExistingTtl: async () => true,
      finalizeInsightsRun: async () => ({ freshnessMetaPatch: { consecutiveFailures: 1 } }),
      writeFreshnessMetadataSafely: async (...args) => {
        writes.push(args);
        return { recordCount: args[2] };
      },
      flushPendingLlmEvents: async () => {},
    }), /canonical envelope is missing/);
    assert.equal(writes.at(-1)[2], 0);
  });

  it('keeps telemetry best-effort after a successful canonical publish', async () => {
    const payload = decorateInsightsRun(validInsights().payload, { outcome: 'published' });
    const result = await seedInsightsOnce({
      now: () => NOW_MS,
      acquireLock: async () => ({ locked: true, skipped: false }),
      releaseLock: async () => {},
      withRetry: async (fn) => fn(),
      fetchInsights: async () => payload,
      atomicPublish: async () => ({ payloadBytes: 123 }),
      finalizeInsightsRun: async () => ({ freshnessMetaPatch: {} }),
      writeFreshnessMetadataSafely: async () => ({ fetchedAt: NOW_MS }),
      verifySeedKey: async () => true,
      flushPendingLlmEvents: async () => { throw new Error('telemetry down'); },
    });
    assert.equal(result.status, 'published');
  });

  it('unwraps both Redis envelopes and legacy bare payloads', () => {
    assert.deepEqual(unwrapStoredInsights(JSON.stringify({ _seed: { state: 'OK' }, data: { status: 'ok' } })), {
      seed: { state: 'OK' },
      payload: { status: 'ok' },
    });
    assert.deepEqual(unwrapStoredInsights({ status: 'ok' }), { seed: null, payload: { status: 'ok' } });
    assert.equal(unwrapStoredInsights(null), null);
  });

  it('rejects uncited, out-of-range, stale, and non-OK snapshots', () => {
    assert.equal(verifyInsightsSnapshot(validInsights({ worldBrief: 'No citation.' }), NOW_MS, NOW_MS), null);
    assert.equal(verifyInsightsSnapshot(validInsights({ worldBrief: 'Bad citation [2].', briefStoryLines: [] }), NOW_MS, NOW_MS), null);
    assert.equal(verifyInsightsSnapshot(validInsights({}, { state: 'RETRY' }), NOW_MS, NOW_MS), null);
    assert.equal(verifyInsightsSnapshot(validInsights({}, { fetchedAt: NOW_MS + 6 * 60_000 }), NOW_MS, NOW_MS), null);
    assert.equal(verifyInsightsSnapshot(
      validInsights(
        { generatedAt: '2026-08-07T08:00:00.000Z' },
        { fetchedAt: Date.parse('2026-08-07T08:00:00.000Z') },
      ),
      NOW_MS - 15 * 60_000,
      NOW_MS,
    ), null);
  });
});
