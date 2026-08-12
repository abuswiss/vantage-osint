import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getResilienceScore } from '../server/worldmonitor/resilience/v1/get-resilience-score.ts';
import {
  RESILIENCE_SCORE_CACHE_PREFIX,
  RESILIENCE_STATIC_INDEX_KEY,
  RESILIENCE_STATIC_META_KEY,
  isUsableResilienceSourcePlane,
} from '../server/worldmonitor/resilience/v1/_shared.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalVercelEnv = process.env.VERCEL_ENV;
const originalPillarCombine = process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'false';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restore('UPSTASH_REDIS_REST_URL', originalRedisUrl);
  restore('UPSTASH_REDIS_REST_TOKEN', originalRedisToken);
  restore('VERCEL_ENV', originalVercelEnv);
  restore('RESILIENCE_PILLAR_COMBINE_ENABLED', originalPillarCombine);
});

const HEALTHY_META = {
  fetchedAt: Date.parse('2026-08-09T09:00:00.000Z'),
  recordCount: 196,
};

function cachedObservedZero(countryCode = 'UA') {
  return {
    countryCode,
    overallScore: 0,
    baselineScore: 0,
    stressScore: 0,
    stressFactor: 0.5,
    level: 'low',
    domains: [
      {
        id: 'recovery',
        score: 0,
        weight: 1,
        dimensions: [
          {
            id: 'sovereignFiscalBuffer',
            score: 0,
            coverage: 1,
            observedWeight: 1,
            imputedWeight: 0,
            imputationClass: '',
          },
        ],
      },
    ],
    trend: 'stable',
    change30d: 0,
    lowConfidence: false,
    imputationShare: 0,
    dataVersion: '2026-08-09',
    pillars: [],
    schemaVersion: '2.0',
    headlineEligible: true,
    _formula: 'd6',
  };
}

async function assertDataUnavailable(fixtures: Record<string, unknown>): Promise<void> {
  installRedis(fixtures);
  await assert.rejects(
    getResilienceScore(
      { request: new Request('https://vantage-osint.vercel.app/api/resilience/v1/get-resilience-score?countryCode=UA') } as never,
      { countryCode: 'UA' },
    ),
    (error: unknown) => {
      const apiError = error as { statusCode?: unknown; body?: unknown };
      assert.equal(apiError.statusCode, 503);
      assert.equal(typeof apiError.body, 'string');
      assert.equal(JSON.parse(String(apiError.body)).code, 'RESILIENCE_DATA_UNAVAILABLE');
      return true;
    },
  );
}

describe('resilience source-plane contract', () => {
  it('requires a real static snapshot and nonempty country index', () => {
    assert.equal(isUsableResilienceSourcePlane(null, null), false);
    assert.equal(isUsableResilienceSourcePlane({}, { countries: ['UA'] }), false);
    assert.equal(isUsableResilienceSourcePlane({ ...HEALTHY_META, recordCount: 0 }, { countries: ['UA'] }), false);
    assert.equal(isUsableResilienceSourcePlane(HEALTHY_META, { countries: [] }), false);
    assert.equal(isUsableResilienceSourcePlane(HEALTHY_META, { countries: ['UA'] }), true);
  });

  it('accepts an error heartbeat that still points at a valid last-good snapshot', () => {
    assert.equal(
      isUsableResilienceSourcePlane(
        { ...HEALTHY_META, status: 'error', message: 'latest refresh failed; preserving prior snapshot' },
        { countries: ['UA'], recordCount: 1 },
        'UA',
      ),
      true,
    );
  });

  it('does not treat a healthy global meta or populated US sample as observed UA coverage', () => {
    const sampleOnlyIndex = { countries: ['US'], recordCount: 1 };
    assert.equal(isUsableResilienceSourcePlane(HEALTHY_META, sampleOnlyIndex, 'US'), true);
    assert.equal(isUsableResilienceSourcePlane(HEALTHY_META, sampleOnlyIndex, 'UA'), false);
  });

  it('fails closed on a cold empty Vantage data plane', async () => {
    await assertDataUnavailable({});
  });

  it('fails closed before accepting a cached score when the source plane is empty', async () => {
    await assertDataUnavailable({
      [`${RESILIENCE_SCORE_CACHE_PREFIX}UA`]: cachedObservedZero(),
    });
  });

  it('fails closed when global source metadata is healthy but the requested country is outside the index', async () => {
    await assertDataUnavailable({
      [RESILIENCE_STATIC_META_KEY]: HEALTHY_META,
      [RESILIENCE_STATIC_INDEX_KEY]: { countries: ['US'], recordCount: 1 },
      [`${RESILIENCE_SCORE_CACHE_PREFIX}UA`]: cachedObservedZero(),
    });
  });

  it('serves a healthy requested-country cached score and preserves its observed zero', async () => {
    installRedis({
      [RESILIENCE_STATIC_META_KEY]: HEALTHY_META,
      [RESILIENCE_STATIC_INDEX_KEY]: { countries: ['UA'], recordCount: 1 },
      [`${RESILIENCE_SCORE_CACHE_PREFIX}UA`]: cachedObservedZero(),
    });

    const response = await getResilienceScore(
      { request: new Request('https://vantage-osint.vercel.app/api/resilience/v1/get-resilience-score?countryCode=UA') } as never,
      { countryCode: 'UA' },
    );

    assert.equal(response.overallScore, 0);
    assert.equal(response.level, 'low');
    const observed = response.domains[0]?.dimensions[0];
    assert.equal(observed?.score, 0);
    assert.equal(observed?.coverage, 1);
    assert.equal(observed?.observedWeight, 1);
  });
});
