/**
 * fetchForecastScorecard() is the forecast-record trust view's only data
 * source. Two contract points pinned here: transport failure resolves to
 * null (the panel renders forecasts without the record — never blocks), and
 * missing wire arrays/flags normalize to safe defaults so the renderer can
 * consume the payload without defensive checks.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fetchForecastScorecard, normalizeForecastScorecard } from '../src/services/forecast.ts';

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchForecastScorecard', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('normalizes missing arrays and flags', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      assert.ok(url.includes('/api/forecast/v1/get-forecast-scorecard'), `unexpected URL ${url}`);
      return jsonResponse({
        schemaVersion: 1,
        generatedAt: 1754600000000,
        rollingWindowDays: 180,
        methodology: 'test',
        totals: {
          entries: 3, resolved: 1, pending: 2, pendingJudge: 0,
          scored: 1, void: 0, voidRate: 0, publicationCoverage: 0.33,
        },
      });
    }) as typeof fetch;

    const scorecard = await fetchForecastScorecard();
    assert.ok(scorecard);
    assert.deepEqual(scorecard.byDomain, []);
    assert.deepEqual(scorecard.byGenerationOrigin, []);
    assert.deepEqual(scorecard.calibration, []);
    assert.equal(scorecard.degraded, false);
    assert.equal(scorecard.stale, false);
    assert.equal(scorecard.error, '');
    assert.equal(scorecard.totals?.scored, 1);
  });

  it('resolves null on transport failure instead of throwing', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('network down');
    }) as typeof fetch;
    assert.equal(await fetchForecastScorecard(), null);
  });

  it('resolves null on a non-2xx response', async () => {
    globalThis.fetch = (async () => new Response('upstream error', { status: 502 })) as typeof fetch;
    assert.equal(await fetchForecastScorecard(), null);
  });

  it('strictly normalizes a hostile wire payload instead of trusting the generated shape', async () => {
    globalThis.fetch = (async () => jsonResponse({
      schemaVersion: '<script>alert(1)</script>',
      generatedAt: '"><img src=x onerror=alert(1)>',
      rollingWindowDays: -30,
      methodology: { nested: 'object' },
      totals: {
        entries: '9001', resolved: -2, pending: 3.9, pendingJudge: null,
        scored: 1e308, void: [], voidRate: 42, publicationCoverage: -1,
      },
      overall: { count: 10, brier: 99, logScore: 'nope' },
      skill: {
        count: '41', brier: -0.5, logScore: 0.4,
        excludedScored: '<b>8</b>', excludedOrigins: [{ evil: true }, 'state_derived', 7],
      },
      vsMarketSkill: { count: 20, forecastBrier: '0.18', marketBrier: 0.2, brierDelta: 0.02 },
      byDomain: [{ domain: 12, scored: '3' }, 'garbage', null],
      byGenerationOrigin: 'not-an-array',
      calibration: [
        { bucket: 'ok', minProbability: -4, maxProbability: 7, count: 2.9, predictedMean: 5, realizedRate: '1', brier: 3 },
        42,
      ],
      degraded: 'yes',
      stale: 1,
      error: ['x'],
    })) as typeof fetch;

    const sc = await fetchForecastScorecard();
    assert.ok(sc);
    assert.equal(sc.schemaVersion, 0);
    assert.equal(sc.generatedAt, 0, 'non-numeric timestamp must not survive as markup fodder');
    assert.equal(sc.rollingWindowDays, 0);
    assert.equal(sc.methodology, '');
    assert.deepEqual(sc.totals, {
      entries: 0, resolved: 0, pending: 3, pendingJudge: 0,
      scored: 0, void: 0, voidRate: 1, publicationCoverage: 0,
    });
    assert.equal(sc.overall, undefined, 'a summary with an out-of-range Brier is structurally invalid');
    assert.ok(sc.skill);
    assert.equal(sc.skill.count, 0);
    assert.equal(sc.skill.brier, undefined, 'negative Brier must be dropped, not rendered');
    assert.equal(sc.skill.excludedScored, 0);
    assert.deepEqual(sc.skill.excludedOrigins, ['state_derived'], 'non-string origins are filtered');
    assert.equal(sc.vsMarketSkill, undefined, 'a market block with a non-numeric Brier is invalid as a whole');
    assert.equal(sc.byDomain.length, 1);
    assert.deepEqual(sc.byDomain[0], { domain: '', resolved: 0, scored: 0, void: 0, voidRate: 0 });
    assert.deepEqual(sc.byGenerationOrigin, []);
    assert.equal(sc.calibration.length, 1);
    // predictedMean 5 clamps to 1; realizedRate '1' and brier 3 are dropped.
    assert.deepEqual(sc.calibration[0], {
      bucket: 'ok', minProbability: 0, maxProbability: 1, count: 2, predictedMean: 1,
    });
    assert.equal(sc.degraded, false);
    assert.equal(sc.stale, false);
    assert.equal(sc.error, '');
  });

  it('keeps server degraded/error semantics and clamps sizes', () => {
    const sc = normalizeForecastScorecard({
      generatedAt: 1754600000000.9,
      degraded: true,
      stale: true,
      error: 'forecast_scorecard_backend_unavailable' + 'x'.repeat(1000),
      methodology: 'm'.repeat(1000),
      calibration: Array.from({ length: 500 }, () => ({ bucket: 'b', minProbability: 0, maxProbability: 1, count: 1 })),
      totals: { entries: Infinity, voidRate: Number.NaN },
      vsMarketSkill: { count: 12, forecastBrier: 0.18, marketBrier: 0.22, brierDelta: 0.04 },
    });
    assert.equal(sc.degraded, true);
    assert.equal(sc.stale, true);
    assert.ok(sc.error.startsWith('forecast_scorecard_backend_unavailable'));
    assert.ok(sc.error.length <= 400, 'strings are length-capped');
    assert.ok(sc.methodology.length <= 400);
    assert.equal(sc.calibration.length, 50, 'hostile array sizes are bounded');
    assert.equal(sc.generatedAt, 1754600000000, 'timestamps floor to integers');
    assert.equal(sc.totals?.entries, 0, 'Infinity is not a count');
    assert.equal(sc.totals?.voidRate, 0, 'NaN is not a ratio');
    assert.deepEqual(sc.vsMarketSkill, { count: 12, forecastBrier: 0.18, marketBrier: 0.22, brierDelta: 0.04 });
  });

  it('normalizes a fully non-object payload to a safe empty scorecard', () => {
    for (const hostile of [null, undefined, 'string', 42, ['array']]) {
      const sc = normalizeForecastScorecard(hostile);
      assert.equal(sc.generatedAt, 0);
      assert.equal(sc.totals?.entries, 0);
      assert.deepEqual(sc.calibration, []);
      assert.equal(sc.degraded, false);
    }
  });
});
