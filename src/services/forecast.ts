
import type { Forecast, GetForecastsResponse, GetForecastScorecardResponse } from '@/generated/client/worldmonitor/forecast/v1/service_client';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { publicRpcFetch } from '@/services/public-rpc-fetch';
import { ForecastServiceClient } from '@/services/generated-rpc-clients';

export type { Forecast };

export interface ForecastFeed {
  forecasts: Forecast[];
  generatedAt: number;
  degraded: boolean;
  stale: boolean;
  error: string;
}

export { escapeHtml } from '@/utils/sanitize';

let _client: InstanceType<typeof ForecastServiceClient> | null = null;

function getClient(): InstanceType<typeof ForecastServiceClient> {
  if (!_client) {
    _client = new ForecastServiceClient(getRpcBaseUrl(), {
      fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    });
  }
  return _client;
}

// The unfiltered feed is the shared production payload — identical for every caller —
// so it goes through its CDN-shielded public URL (#5300). This matters because
// getHydratedData() is one-shot: every 30-minute dashboard refresh fell through to
// this call, and with no CDN in front of it that was ~17.5k uncached origin reads/day
// of a 188 KB payload. A FILTERED feed (domain/region) is caller-varying, so it keeps
// the credentialed client.
let _publicClient: InstanceType<typeof ForecastServiceClient> | null = null;
function getPublicClient(): InstanceType<typeof ForecastServiceClient> {
  if (!_publicClient) {
    _publicClient = new ForecastServiceClient(getRpcBaseUrl(), { fetch: publicRpcFetch });
  }
  return _publicClient;
}

export async function fetchForecastFeed(domain?: string, region?: string): Promise<ForecastFeed> {
  const filtered = Boolean(domain || region);
  const client = filtered ? getClient() : getPublicClient();
  const resp = await client.getForecasts({ domain: domain || '', region: region || '' });
  return normalizeForecastFeed(resp);
}

function normalizeForecastFeed(resp: GetForecastsResponse): ForecastFeed {
  return {
    forecasts: resp.forecasts || [],
    generatedAt: resp.generatedAt || 0,
    degraded: resp.degraded === true,
    stale: resp.stale === true,
    error: resp.error || '',
  };
}

export async function fetchSimulationOutcome(): Promise<string> {
  const resp = await getClient().getSimulationOutcome({ runId: '' });
  return (resp.found && resp.theaterSummariesJson) ? resp.theaterSummariesJson : '';
}

export type ForecastScorecard = GetForecastScorecardResponse;

// ── Scorecard normalization ────────────────────────────────────────────────
//
// The scorecard is operator-seeded JSON out of Redis: the generated
// TypeScript shape describes intent, not what actually arrives. ForecastPanel
// interpolates many of these values into trustedHtml, so every field is
// coerced to a provably safe runtime value here — counts to finite
// non-negative integers, ratios/probabilities clamped to [0,1], strings
// length-capped, arrays bounded, and optional blocks (summaries, skill,
// market, calibration) kept only when structurally valid. A malformed value
// must neither inject markup nor crash rendering.

const MAX_SCORECARD_GROUPS = 50;
const MAX_SCORECARD_STRING = 400;

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? Math.floor(value)
    : 0;
}

function safeRatio(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

/** Brier-like score: finite and within the binary Brier range, else absent. */
function safeBrier(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function safeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_SCORECARD_STRING) : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, MAX_SCORECARD_GROUPS) : [];
}

type ScorecardTotals = NonNullable<GetForecastScorecardResponse['totals']>;
type ScorecardSummary = NonNullable<GetForecastScorecardResponse['overall']>;
type ScorecardSkill = NonNullable<GetForecastScorecardResponse['skill']>;
type ScorecardMarketSkill = NonNullable<GetForecastScorecardResponse['vsMarketSkill']>;

function normalizeTotals(value: unknown): ScorecardTotals {
  const raw = isRecord(value) ? value : {};
  return {
    entries: safeCount(raw.entries),
    resolved: safeCount(raw.resolved),
    pending: safeCount(raw.pending),
    pendingJudge: safeCount(raw.pendingJudge),
    scored: safeCount(raw.scored),
    void: safeCount(raw.void),
    voidRate: safeRatio(raw.voidRate),
    publicationCoverage: safeRatio(raw.publicationCoverage),
  };
}

function normalizeSummary(value: unknown): ScorecardSummary | undefined {
  if (!isRecord(value)) return undefined;
  const count = safeCount(value.count);
  const brier = safeBrier(value.brier);
  const logScore = safeFinite(value.logScore);
  if (count === 0 || brier === undefined || logScore === undefined) return undefined;
  return { count, brier, logScore };
}

function normalizeSkill(value: unknown): ScorecardSkill | undefined {
  if (!isRecord(value)) return undefined;
  const skill: ScorecardSkill = {
    count: safeCount(value.count),
    excludedScored: safeCount(value.excludedScored),
    excludedOrigins: safeArray(value.excludedOrigins)
      .filter((o): o is string => typeof o === 'string')
      .map((o) => o.slice(0, MAX_SCORECARD_STRING)),
  };
  const brier = safeBrier(value.brier);
  const logScore = safeFinite(value.logScore);
  if (brier !== undefined) skill.brier = brier;
  if (logScore !== undefined) skill.logScore = logScore;
  return skill;
}

function normalizeMarketSkill(value: unknown): ScorecardMarketSkill | undefined {
  if (!isRecord(value)) return undefined;
  const count = safeCount(value.count);
  const forecastBrier = safeBrier(value.forecastBrier);
  const marketBrier = safeBrier(value.marketBrier);
  const brierDelta = safeFinite(value.brierDelta);
  if (count === 0 || forecastBrier === undefined || marketBrier === undefined || brierDelta === undefined) {
    return undefined;
  }
  return { count, forecastBrier, marketBrier, brierDelta };
}

function normalizeGroupCounts(value: Record<string, unknown>) {
  const brier = safeBrier(value.brier);
  const logScore = safeFinite(value.logScore);
  return {
    resolved: safeCount(value.resolved),
    scored: safeCount(value.scored),
    void: safeCount(value.void),
    voidRate: safeRatio(value.voidRate),
    ...(brier !== undefined ? { brier } : {}),
    ...(logScore !== undefined ? { logScore } : {}),
  };
}

function normalizeCalibrationBucket(value: unknown) {
  if (!isRecord(value)) return null;
  const bucket = {
    bucket: safeString(value.bucket),
    minProbability: safeRatio(value.minProbability),
    maxProbability: safeRatio(value.maxProbability),
    count: safeCount(value.count),
  };
  const predictedMean = typeof value.predictedMean === 'number' && Number.isFinite(value.predictedMean)
    ? safeRatio(value.predictedMean)
    : undefined;
  const realizedRate = typeof value.realizedRate === 'number' && Number.isFinite(value.realizedRate)
    ? safeRatio(value.realizedRate)
    : undefined;
  const brier = safeBrier(value.brier);
  return {
    ...bucket,
    ...(predictedMean !== undefined ? { predictedMean } : {}),
    ...(realizedRate !== undefined ? { realizedRate } : {}),
    ...(brier !== undefined ? { brier } : {}),
  };
}

/** Exported for DOM tests that feed hostile payloads through the panel. */
export function normalizeForecastScorecard(raw: unknown): ForecastScorecard {
  const resp = isRecord(raw) ? raw : {};
  return {
    schemaVersion: safeCount(resp.schemaVersion),
    generatedAt: safeCount(resp.generatedAt),
    rollingWindowDays: safeCount(resp.rollingWindowDays),
    methodology: safeString(resp.methodology),
    totals: normalizeTotals(resp.totals),
    overall: normalizeSummary(resp.overall),
    skill: normalizeSkill(resp.skill),
    vsMarketSkill: normalizeMarketSkill(resp.vsMarketSkill),
    byDomain: safeArray(resp.byDomain)
      .filter(isRecord)
      .map((g) => ({ domain: safeString(g.domain), ...normalizeGroupCounts(g) })),
    byGenerationOrigin: safeArray(resp.byGenerationOrigin)
      .filter(isRecord)
      .map((g) => ({ generationOrigin: safeString(g.generationOrigin), ...normalizeGroupCounts(g) })),
    calibration: safeArray(resp.calibration)
      .map(normalizeCalibrationBucket)
      .filter((b): b is NonNullable<typeof b> => b !== null),
    degraded: resp.degraded === true,
    stale: resp.stale === true,
    error: safeString(resp.error),
  };
}

/**
 * Scorecard for the "Forecast record" trust view. Returns null on transport
 * failure so the panel renders forecasts without the record — the scorecard
 * is contextual, never blocking. A server-side failure arrives as
 * degraded/error INSIDE the payload (the handler distinguishes a backend
 * outage from a healthy empty scorecard) and is the caller's copy to render.
 *
 * Credentialed client on purpose: the public CDN path is an exact-shape
 * allowlist (src/shared/public-rpc-cache.ts) and this request only fires for
 * users with the classic forecast panel open, so it does not need a shield.
 */
export async function fetchForecastScorecard(): Promise<ForecastScorecard | null> {
  try {
    return normalizeForecastScorecard(await getClient().getForecastScorecard({}));
  } catch {
    return null;
  }
}
