import type { GetResilienceRankingResponse, GetResilienceScoreResponse, ResilienceDomain, ResilienceDimension, ResilienceRankingItem, ScoreInterval } from '@/generated/client/worldmonitor/resilience/v1/service_client';
import { VANTAGE_PUBLIC_MODE } from '@/config/product-policy';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { ResilienceServiceClient } from '@/services/generated-rpc-clients';

export type ResilienceScoreResponse = GetResilienceScoreResponse;
export type ResilienceRankingResponse = GetResilienceRankingResponse;
export type { ResilienceDomain, ResilienceDimension, ResilienceRankingItem, ScoreInterval };

let _client: InstanceType<typeof ResilienceServiceClient> | null = null;

function getClient(): InstanceType<typeof ResilienceServiceClient> {
  if (!_client) {
    _client = new ResilienceServiceClient(getRpcBaseUrl(), {
      fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    });
  }
  return _client;
}

function normalizeCountryCode(countryCode: string): string {
  const normalized = countryCode.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : '';
}

export async function getResilienceScore(countryCode: string): Promise<ResilienceScoreResponse> {
  const normalized = normalizeCountryCode(countryCode);
  try {
    return await getClient().getResilienceScore({ countryCode: normalized });
  } catch (error) {
    if (VANTAGE_PUBLIC_MODE && isUnavailableSourcePlaneError(error)) {
      return unavailableResilienceScore(normalized);
    }
    throw error;
  }
}

export async function getResilienceRanking(): Promise<ResilienceRankingResponse> {
  return getClient().getResilienceRanking({});
}

function isUnavailableSourcePlaneError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { statusCode?: unknown; body?: unknown };
  if (candidate.statusCode !== 503 || typeof candidate.body !== 'string') return false;
  try {
    const body = JSON.parse(candidate.body) as { code?: unknown };
    return body.code === 'RESILIENCE_DATA_UNAVAILABLE';
  } catch {
    return false;
  }
}

function unavailableResilienceScore(countryCode: string): ResilienceScoreResponse {
  return {
    countryCode,
    overallScore: 0,
    level: 'unknown',
    domains: [],
    trend: 'stable',
    change30d: 0,
    lowConfidence: true,
    imputationShare: 0,
    baselineScore: 0,
    stressScore: 0,
    stressFactor: 0,
    dataVersion: '',
    pillars: [],
    schemaVersion: '2.0',
    headlineEligible: false,
  };
}
