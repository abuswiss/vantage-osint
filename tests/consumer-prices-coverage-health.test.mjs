// Consumer-price coverage uses normal health rules after the August rollout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { __testing__ } from '../api/health.js';
import {
  COVERAGE_ACTIVATION_SCHEMA_VERSION as CORE_SCHEMA_VERSION,
  coverageActivationKey as coreCoverageActivationKey,
  isActivatingCoverage as coreIsActivatingCoverage,
  summarizeMarketCoverage,
} from '../consumer-prices-core/src/ops/coverage.ts';
import { emptyCoverage } from '../scripts/seed-consumer-prices.mjs';
import { findOperationalProblems } from '../scripts/check-seed-freshness.mjs';


const {
  classifyKey, healthResponseBody, computeOverallStatus, STATUS_COUNTS,
  BOOTSTRAP_KEYS, SEED_META, ACTIVATION_MARKERS, CONSUMER_PRICE_HEALTH_MARKETS,
  consumerPriceCoverageActivationKey, consumerPriceCoverageHealthName,
} = __testing__;
const NOW = Date.parse('2026-09-04T00:00:00Z');
const US = consumerPriceCoverageHealthName('us');

// Same ctx shape the handler builds (api/health.js), plus `activatedNames`.
function makeCtx({ strens = {}, errors = {}, metaValues = {}, metaErrors = {}, activated = [], now } = {}) {
  return {
    keyStrens: new Map(Object.entries(strens)),
    keyErrors: new Map(Object.entries(errors)),
    keyMetaValues: new Map(
      Object.entries(metaValues).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
    ),
    keyMetaErrors: new Map(Object.entries(metaErrors)),
    activatedNames: new Set(activated),
    now,
  };
}

function classifyCoverage(name, { now, activated = [], strens = {}, metaValues = {} } = {}) {
  return classifyKey(name, BOOTSTRAP_KEYS[name], { allowOnDemand: false }, makeCtx({
    now,
    activated,
    strens,
    metaValues,
  }));
}

test('every market remains strict before and after first publication', () => {
  assert.equal(CONSUMER_PRICE_HEALTH_MARKETS.length, 8);
  for (const market of CONSUMER_PRICE_HEALTH_MARKETS) {
    const name = consumerPriceCoverageHealthName(market);
    for (const activated of [[], [name]]) {
      const entry = classifyCoverage(name, { now: NOW, activated });
      assert.equal(entry.status, 'EMPTY', market);
      assert.equal(entry.records, 0);
      assert.equal(entry.activated, activated.length > 0);
      assert.equal(STATUS_COUNTS[entry.status], 'crit');
    }
  }
});

test('activation diagnostics retain the publisher key contract', () => {
  assert.equal(CORE_SCHEMA_VERSION, 1);
  for (const market of CONSUMER_PRICE_HEALTH_MARKETS) {
    assert.equal(consumerPriceCoverageActivationKey(market), coreCoverageActivationKey(market));
    assert.equal(ACTIVATION_MARKERS[consumerPriceCoverageHealthName(market)], coreCoverageActivationKey(market));
  }
});

for (const [name, meta, expected] of [
  ['healthy', { recordCount: 11, coverage: { status: 'healthy', completionRatio: 1 } }, 'OK'],
  ['empty', { recordCount: 0 }, 'EMPTY_DATA'],
  ['missing coverage', { recordCount: 4 }, 'COVERAGE_DEGRADED'],
  ['partial', { recordCount: 10, coverage: { status: 'partial', completionRatio: 0.9 } }, 'COVERAGE_PARTIAL'],
  ['stale', { fetchedAt: NOW - 3000 * 60_000, recordCount: 4, coverage: { status: 'healthy', completionRatio: 1 } }, 'STALE_SEED'],
]) {
  test(`published coverage preserves ${name} status`, () => {
    const entry = classifyCoverage(US, {
      now: NOW, strens: { [BOOTSTRAP_KEYS[US]]: 4096 },
      metaValues: { [SEED_META[US].key]: { fetchedAt: NOW - 60_000, ...meta } },
    });
    assert.equal(entry.status, expected);
  });
}

test('missing coverage reaches the compact response and freshness monitor', () => {
  const entry = classifyCoverage(US, { now: NOW });
  const body = healthResponseBody({
    status: 'UNHEALTHY', checkedAt: new Date(NOW).toISOString(),
    summary: { total: 1, ok: 0, warn: 0, crit: 1 }, checks: { [US]: entry },
  }, true);
  assert.equal(body.problems[US].status, 'EMPTY');
  assert.deepEqual(findOperationalProblems(body).map(problem => problem.name), [US]);
  assert.equal(computeOverallStatus({ warn: 0, onDemandWarn: 0, crit: 8 }, 253).overall, 'UNHEALTHY');
  assert.equal(computeOverallStatus({ warn: 1, onDemandWarn: 1, crit: 0 }, 253).overall, 'HEALTHY');
});

const coverageOf = (retailers) => summarizeMarketCoverage('us', '1754000000000', retailers);

const ACTIVATION_CASES = [
  {
    name: 'real coverage with attempted pages activates',
    snapshot: coverageOf([
      { slug: 'r-a', name: 'A', lastRunAt: null, runStatus: 'completed', pagesAttempted: 6, pagesSucceeded: 6, errorsCount: 0, rejectedCount: 0 },
    ]),
    expected: true,
  },
  {
    name: 'a degraded-but-real run activates (truthful report of a failing scrape)',
    snapshot: coverageOf([
      { slug: 'r-a', name: 'A', lastRunAt: null, runStatus: 'failed', pagesAttempted: 6, pagesSucceeded: 0, errorsCount: 6, rejectedCount: 0 },
    ]),
    expected: true,
  },
  {
    name: 'retailers configured but zero pages ever attempted does NOT activate',
    snapshot: coverageOf([
      { slug: 'r-a', name: 'A', lastRunAt: null, runStatus: null, pagesAttempted: 0, pagesSucceeded: 0, errorsCount: 0, rejectedCount: 0 },
    ]),
    expected: false,
  },
  { name: 'no active retailers does NOT activate', snapshot: coverageOf([]), expected: false },
  { name: 'the upstream-unavailable placeholder does NOT activate', snapshot: emptyCoverage('us'), expected: false },
  { name: 'null does NOT activate', snapshot: null, expected: false },
  { name: 'undefined does NOT activate', snapshot: undefined, expected: false },
  // Raw shapes: summarizeMarketCoverage normalizes through nonNegativeInt, so the
  // cases above can never exercise a malformed attemptedPages. The predicate must
  // still fail closed on one, since a future caller could hand it an unnormalized
  // payload (e.g. straight off an HTTP body).
  { name: 'a negative attemptedPages does NOT activate', snapshot: { retailers: [{}], attemptedPages: -5 }, expected: false },
  { name: 'a NaN attemptedPages does NOT activate', snapshot: { retailers: [{}], attemptedPages: Number.NaN }, expected: false },
  { name: 'a missing attemptedPages does NOT activate', snapshot: { retailers: [{}] }, expected: false },
  { name: 'a non-array retailers does NOT activate', snapshot: { retailers: 'nope', attemptedPages: 9 }, expected: false },
  { name: 'a numeric-string attemptedPages activates (Number coerces)', snapshot: { retailers: [{}], attemptedPages: '9' }, expected: true },
];

for (const { name, snapshot, expected } of ACTIVATION_CASES) {
  test(`activation predicate: ${name}`, () => {
    assert.equal(coreIsActivatingCoverage(snapshot), expected);
  });
}

test('activation is withheld from the degenerate snapshot health would otherwise see as coverage', () => {
  // summarizeMarketCoverage reports status 'degraded' for configured-but-never-run
  // retailers. That IS publishable and truthful, but it is not proof the market's
  // pipeline works — and activation is irreversible.
  const neverRan = coverageOf([
    { slug: 'r-a', name: 'A', lastRunAt: null, runStatus: null, pagesAttempted: 0, pagesSucceeded: 0, errorsCount: 0, rejectedCount: 0 },
  ]);
  assert.equal(neverRan.status, 'degraded');
  assert.equal(neverRan.completionRatio, null);
  assert.equal(coreIsActivatingCoverage(neverRan), false);
});

// ── Manual fallback publisher ───────────────────────────────────────────────

test('the manual fallback never writes an activation marker', () => {
  // It publishes the coverage key with a 30-minute TTL (TTL_COVERAGE) because it
  // is a stopgap for a broken publish.ts. Activation is permanent, so claiming it
  // off a 30-minute artifact would strand the market in an unrecoverable EMPTY
  // (crit) once the data expired but the marker did not — fixable only by
  // hand-deleting the Redis key. This test is the guard on that asymmetry.
  const src = readFileSync(new URL('../scripts/seed-consumer-prices.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /seed-activated/, 'the fallback must not construct an activation key');
  assert.doesNotMatch(src, /_upstash-rest/, 'and must not reach for the raw Redis command helper to write one');

  // The behavioural half: the short TTL that makes activation unsafe is real, and
  // it is an order of magnitude below the publisher's durable 26h key.
  assert.match(src, /const TTL_COVERAGE\s*=\s*1800;/, 'coverage key stays short-lived here');
  assert.ok(1800 * 4 < 93600, 'publish.ts writes 93600s (26h); the fallback is nowhere near durable');
});

