/**
 * "Forecast record" trust view: the classic ForecastPanel renders the
 * getForecastScorecard contract as one restrained summary row plus an
 * expandable detail block. Honesty rules pinned here: Brier is shown with
 * "lower is better" and never converted to an accuracy %, zero/tiny samples
 * never read as proven skill, the synthetic/shadow exclusion is disclosed,
 * and a failed or degraded scorecard says "unavailable" without blocking the
 * forecasts themselves.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const fetchForecastScorecard = vi.hoisted(() => vi.fn());

vi.mock('@/services/forecast', async () => {
  const { escapeHtml } = await import('@/utils/sanitize');
  return {
    escapeHtml,
    fetchForecastScorecard,
    fetchForecastFeed: vi.fn(async () => ({ forecasts: [], generatedAt: 0, degraded: false, stale: false, error: '' })),
    fetchSimulationOutcome: vi.fn(async () => ''),
  };
});

import { ForecastPanel } from '@/components/ForecastPanel';
import type { Forecast, ForecastScorecard } from '@/services/forecast';
import { initI18n } from '@/services/i18n';

function forecast(overrides: Partial<Forecast> = {}): Forecast {
  return {
    id: 'f1',
    title: 'Example forecast',
    probability: 0.55,
    domain: 'conflict',
    trend: 'stable',
    region: 'global',
    signals: [],
    ...overrides,
  } as unknown as Forecast;
}

function scorecard(overrides: Partial<ForecastScorecard> = {}): ForecastScorecard {
  return {
    schemaVersion: 1,
    generatedAt: Date.now() - 60 * 60 * 1000,
    rollingWindowDays: 180,
    methodology: 'Brier/log score over resolved YES/NO published forecast windows.',
    totals: {
      entries: 120,
      resolved: 60,
      pending: 55,
      pendingJudge: 5,
      scored: 50,
      void: 10,
      voidRate: 0.166667,
      publicationCoverage: 0.416667,
    },
    overall: { count: 50, brier: 0.21, logScore: 0.52 },
    byDomain: [],
    byGenerationOrigin: [],
    calibration: [],
    degraded: false,
    stale: false,
    error: '',
    skill: { count: 42, brier: 0.18, logScore: 0.48, excludedScored: 8, excludedOrigins: ['state_derived'] },
    ...overrides,
  };
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('ForecastPanel forecast record', () => {
  let panel: ForecastPanel | null = null;

  beforeAll(async () => {
    await initI18n();
  });

  beforeEach(() => {
    fetchForecastScorecard.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    panel?.destroy();
    panel = null;
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  async function mount(): Promise<HTMLElement> {
    panel = new ForecastPanel();
    const element = panel.getElement();
    document.body.appendChild(element);
    panel.updateForecasts([forecast()]);
    // Panel content application is debounced (150ms); the scorecard patch
    // lands either before (fallback re-render) or after (in-place patch).
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(500);
    return element;
  }

  it('renders one restrained summary row with Brier as lower-is-better', async () => {
    fetchForecastScorecard.mockResolvedValue(scorecard());
    const element = await mount();

    const record = element.querySelector('[data-fc-record]') as HTMLElement;
    expect(record).not.toBeNull();
    expect(record.classList.contains('fc-hidden')).toBe(false);
    expect(record.textContent).toContain('Forecast record');
    expect(record.textContent).toContain('Brier 0.18');
    expect(record.textContent).toContain('lower is better');
    expect(record.textContent).toContain('42 scored');
    // Brier must never be converted into an accuracy percentage. (The detail
    // block may SAY "not an accuracy percentage" — that denial is asserted in
    // the details test; the summary row itself must not mention accuracy.)
    expect((record.querySelector('.fc-record-row') as HTMLElement).textContent).not.toMatch(/accuracy/i);
    // 42 scored is not a small sample under the 20 threshold.
    expect(record.textContent).not.toContain('small sample');
  });

  it('expands to details disclosing samples, void rate, and the synthetic exclusion', async () => {
    fetchForecastScorecard.mockResolvedValue(scorecard());
    const element = await mount();

    const detail = element.querySelector('[data-fc-record-detail]') as HTMLElement;
    expect(detail.classList.contains('fc-hidden')).toBe(true);

    const toggle = element.querySelector('[data-fc-record-toggle]') as HTMLButtonElement;
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('aria-controls')).toBe(detail.id);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    expect(detail.classList.contains('fc-hidden')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    expect(detail.textContent).toContain('120 tracked entries');
    expect(detail.textContent).toContain('60 resolved in the last 180 days');
    expect(detail.textContent).toContain('50 graded YES/NO');
    expect(detail.textContent).toContain('10 void');
    expect(detail.textContent).toContain('Headline excludes 8');
    expect(detail.textContent).toContain('state derived');
    expect(detail.textContent).toContain('Including them: Brier 0.21 over 50');
    expect(detail.textContent).toContain('not an accuracy percentage');
    expect(detail.textContent).toContain('not realtime');
  });

  it('shows calibration bands only when adequately supported', async () => {
    fetchForecastScorecard.mockResolvedValue(scorecard({
      skill: { count: 50, brier: 0.18, logScore: 0.48, excludedScored: 0, excludedOrigins: [] },
      calibration: [
        { bucket: '40-50', minProbability: 0.4, maxProbability: 0.5, count: 12, predictedMean: 0.44, realizedRate: 0.38, brier: 0.2 },
        { bucket: '60-70', minProbability: 0.6, maxProbability: 0.7, count: 9, predictedMean: 0.64, realizedRate: 0.7, brier: 0.19 },
        { bucket: '90-100', minProbability: 0.9, maxProbability: 1, count: 2, predictedMean: 0.95, realizedRate: 1, brier: 0.01 },
      ],
    }));
    const element = await mount();
    const detail = element.querySelector('[data-fc-record-detail]') as HTMLElement;

    expect(detail.textContent).toContain('said ~44% → happened 38% of the time (n=12)');
    expect(detail.textContent).toContain('said ~64% → happened 70% of the time (n=9)');
    // The n=2 band is below the support threshold and must not appear.
    expect(detail.textContent).not.toContain('n=2');
  });

  it('withholds calibration below 30 graded forecasts', async () => {
    fetchForecastScorecard.mockResolvedValue(scorecard({
      totals: {
        entries: 40, resolved: 20, pending: 18, pendingJudge: 2,
        scored: 15, void: 5, voidRate: 0.25, publicationCoverage: 0.375,
      },
      skill: { count: 15, brier: 0.22, logScore: 0.55, excludedScored: 0, excludedOrigins: [] },
      overall: { count: 15, brier: 0.22, logScore: 0.55 },
    }));
    const element = await mount();
    const record = element.querySelector('[data-fc-record]') as HTMLElement;

    expect(record.textContent).toContain('small sample');
    expect(record.textContent).toContain('Calibration withheld');
    expect(record.textContent).not.toContain('said ~');
  });

  it('does not show pooled calibration under a headline that excludes scored origins', async () => {
    fetchForecastScorecard.mockResolvedValue(scorecard({
      calibration: [
        { bucket: '40-50', minProbability: 0.4, maxProbability: 0.5, count: 20, predictedMean: 0.44, realizedRate: 0.38, brier: 0.2 },
        { bucket: '60-70', minProbability: 0.6, maxProbability: 0.7, count: 20, predictedMean: 0.64, realizedRate: 0.7, brier: 0.19 },
      ],
    }));
    const element = await mount();
    const detail = element.querySelector('[data-fc-record-detail]') as HTMLElement;

    expect(detail.textContent).toContain('Calibration not shown');
    expect(detail.textContent).not.toContain('said ~');
  });

  it('never claims skill with zero graded outcomes', async () => {
    fetchForecastScorecard.mockResolvedValue(scorecard({
      totals: {
        entries: 30, resolved: 0, pending: 30, pendingJudge: 0,
        scored: 0, void: 0, voidRate: 0, publicationCoverage: 0,
      },
      overall: undefined,
      skill: { count: 0, brier: undefined, logScore: undefined, excludedScored: 0, excludedOrigins: [] },
    }));
    const element = await mount();
    const record = element.querySelector('[data-fc-record]') as HTMLElement;

    expect(record.textContent).toContain('no graded outcomes yet');
    expect(record.textContent).toContain('30 pending');
    expect(record.textContent).not.toContain('Brier');
  });

  it('reports a collapsed funnel when everything graded was synthetic or shadow', async () => {
    fetchForecastScorecard.mockResolvedValue(scorecard({
      overall: { count: 5, brier: 0.1, logScore: 0.3 },
      skill: { count: 0, brier: undefined, logScore: undefined, excludedScored: 5, excludedOrigins: ['state_derived', 'bet_engine'] },
    }));
    const element = await mount();
    const row = element.querySelector('.fc-record-row') as HTMLElement;

    expect(row.textContent).toContain('skill not yet measurable');
    // The headline must not read as a skill claim; the synthetic-inclusive
    // Brier belongs only in the expandable disclosure.
    expect(row.textContent).not.toContain('Brier');
  });

  it('omits the market comparison when the market pool includes entries the headline excludes', async () => {
    // Default scorecard: skill.excludedScored is 8, so vsMarketSkill is
    // pooled over a population the headline never claimed. No market verdict
    // may be minted from it.
    fetchForecastScorecard.mockResolvedValue(scorecard({
      vsMarketSkill: { count: 20, forecastBrier: 0.18, marketBrier: 0.22, brierDelta: 0.04 },
    }));
    const element = await mount();
    const detail = element.querySelector('[data-fc-record-detail]') as HTMLElement;

    expect(detail.textContent).not.toContain('vs prediction markets');
    expect(detail.textContent).not.toMatch(/ahead of|behind the market/);
  });

  it('describes the market comparison without a skill verdict when the pools provably align', async () => {
    fetchForecastScorecard.mockResolvedValue(scorecard({
      skill: { count: 50, brier: 0.18, logScore: 0.48, excludedScored: 0, excludedOrigins: [] },
      vsMarketSkill: { count: 20, forecastBrier: 0.18, marketBrier: 0.22, brierDelta: 0.04 },
    }));
    const element = await mount();
    const detail = element.querySelector('[data-fc-record-detail]') as HTMLElement;

    expect(detail.textContent).toContain('vs prediction markets (20 market-anchored)');
    expect(detail.textContent).toContain('Brier 0.18 vs market 0.22');
    expect(detail.textContent).toContain('lower (better) Brier than the market');
    // Descriptive copy only — never an unqualified market-skill claim.
    expect(detail.textContent).not.toMatch(/ahead of|behind the market/);
  });

  it('renders the healthy-empty handler fallback as "record not published yet"', async () => {
    // No Redis scorecard exists: the handler's fallback is generatedAt 0,
    // empty methodology, zero entries — while forecasts are visibly on
    // screen. That must never read as "no published forecasts".
    fetchForecastScorecard.mockResolvedValue(scorecard({
      generatedAt: 0,
      methodology: '',
      totals: {
        entries: 0, resolved: 0, pending: 0, pendingJudge: 0,
        scored: 0, void: 0, voidRate: 0, publicationCoverage: 0,
      },
      overall: undefined,
      skill: undefined,
    }));
    const element = await mount();
    const record = element.querySelector('[data-fc-record]') as HTMLElement;

    expect(record.textContent).toContain('record not published yet');
    expect(record.textContent).not.toContain('no published forecasts');
  });

  it('reports an empty current record only for a real generated scorecard', async () => {
    fetchForecastScorecard.mockResolvedValue(scorecard({
      totals: {
        entries: 0, resolved: 0, pending: 0, pendingJudge: 0,
        scored: 0, void: 0, voidRate: 0, publicationCoverage: 0,
      },
      overall: undefined,
      skill: undefined,
    }));
    const element = await mount();
    const record = element.querySelector('[data-fc-record]') as HTMLElement;

    expect(record.textContent).toContain('no entries in the current forecast record');
    expect(record.textContent).not.toContain('record not published yet');
  });

  it('renders a hostile payload inert after service normalization', async () => {
    const { normalizeForecastScorecard } = await vi.importActual<typeof import('@/services/forecast')>('@/services/forecast');
    fetchForecastScorecard.mockResolvedValue(normalizeForecastScorecard({
      schemaVersion: '<script>alert(1)</script>',
      generatedAt: Date.now() - 60 * 60 * 1000,
      rollingWindowDays: '<img src=x onerror=window.__pwn=1>',
      methodology: 123,
      totals: {
        entries: 120, resolved: '"><script>alert(2)</script>', pending: -3, pendingJudge: null,
        scored: 40, void: {}, voidRate: 12, publicationCoverage: -1,
      },
      overall: { count: 40, brier: 99, logScore: 'nope' },
      skill: {
        count: '41', brier: 42, logScore: 0.4,
        excludedScored: '<b>8</b>', excludedOrigins: [{}, '<i>state_derived</i>'],
      },
      vsMarketSkill: { count: '99', forecastBrier: Number.POSITIVE_INFINITY, marketBrier: 0.2, brierDelta: 0.1 },
      calibration: [{ bucket: '<script>x</script>', count: '7' }, 'garbage', null],
      degraded: 'yes',
      stale: 0,
      error: null,
    }));
    const element = await mount();

    const record = element.querySelector('[data-fc-record]') as HTMLElement;
    expect(record).not.toBeNull();
    expect(record.textContent).toContain('Forecast record');
    expect(element.querySelector('script, img, i, b')).toBeNull();
    expect(element.innerHTML).not.toContain('onerror');
    expect((window as unknown as { __pwn?: unknown }).__pwn).toBeUndefined();
    // Invalid nested blocks degrade to honest copy, not NaN/undefined text.
    expect(record.textContent).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('still renders forecasts when the scorecard request fails', async () => {
    fetchForecastScorecard.mockResolvedValue(null);
    const element = await mount();

    expect(element.querySelector('.fc-prob-table')).not.toBeNull();
    const record = element.querySelector('[data-fc-record]') as HTMLElement;
    expect(record.textContent).toContain('unavailable');
  });

  it('treats a degraded scorecard as unavailable and flags a stale cache', async () => {
    fetchForecastScorecard.mockResolvedValue(scorecard({ degraded: true }));
    let element = await mount();
    expect((element.querySelector('[data-fc-record]') as HTMLElement).textContent).toContain('unavailable');
    panel?.destroy();
    document.body.innerHTML = '';

    fetchForecastScorecard.mockResolvedValue(scorecard({ stale: true }));
    element = await mount();
    expect((element.querySelector('[data-fc-record]') as HTMLElement).textContent).toContain('stale cache');
  });
});
