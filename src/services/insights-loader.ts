import { getHydratedData } from '@/services/bootstrap';
import { toApiUrl } from '@/services/runtime';

export interface ServerInsightStory {
  primaryTitle: string;
  primarySource: string;
  primaryLink: string;
  pubDate: string;
  /** Number of mentions grouped into the cluster (not publisher diversity). */
  sourceCount: number;
  /** Canonical publisher families represented in this exact story cluster. */
  uniqueSourceCount?: number;
  sources?: string[];
  publisherSources?: string[];
  importanceScore: number;
  velocity: { level: string; sourcesPerHour: number };
  isAlert: boolean;
  category: string;
  threatLevel: string;
  countryCode: string | null;
}

export interface ServerBriefSource {
  title: string;
  source: string;
  url: string;
  publishedAt?: string;
}

export interface ServerInsights {
  worldBrief: string;
  /** #4921: one cited line per top story from the synthesis call —
   * absent on pre-rollout payloads and single-headline (L2) briefs. */
  briefStoryLines?: Array<{ n: number; text: string }>;
  /** #4921: age window of the source material behind this brief. */
  sourceAgeRange?: { newestMs: number; oldestMs: number } | null;
  worldBriefSources?: ServerBriefSource[];
  briefProvider: string;
  status: 'ok' | 'degraded';
  topStories: ServerInsightStory[];
  generatedAt: string;
  clusterCount: number;
  multiSourceCount: number;
  fastMovingCount: number;
  /** #4920 coverage provenance — present on payloads seeded after the
   * completeness-measurement rollout; absent on older cached payloads. */
  provenance?: {
    storiesConsidered: number;
    sourcesConsidered: number;
    selectionDrops?: { admissibility: number; sourceCap: number; overflow: number };
  };
}

let cached: ServerInsights | null = null;
// Server cron interval: scripts/seed-insights.mjs runs every 30 min
// (CACHE_TTL=10800s/3h, maxStaleMin: 30). The previous 15-min freshness gate
// was strictly less than the cron interval, so the panel spent ~50% of every
// 30-min cycle showing UNAVAILABLE + "Waiting for data..." even when the
// system was working perfectly. 60 min = 2× cron interval, gives one full
// missed-tick of headroom before falling through to the client-side path.
// Exported so the regression test asserts against the real value rather than
// inlining a copy that drifts silently when this constant changes.
export const MAX_AGE_MS = 60 * 60 * 1000;
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function isFresh(data: ServerInsights): boolean {
  const generatedAtMs = new Date(data.generatedAt).getTime();
  if (!Number.isFinite(generatedAtMs)) return false;
  const age = Date.now() - generatedAtMs;
  return age >= -MAX_FUTURE_SKEW_MS && age < MAX_AGE_MS;
}

function isInsightStory(value: unknown): value is ServerInsightStory {
  if (!value || typeof value !== 'object') return false;
  const story = value as Partial<ServerInsightStory>;
  return typeof story.primaryTitle === 'string'
    && typeof story.primarySource === 'string'
    && typeof story.primaryLink === 'string'
    && typeof story.sourceCount === 'number'
    && Number.isFinite(story.sourceCount)
    && (story.uniqueSourceCount === undefined
      || (typeof story.uniqueSourceCount === 'number'
        && Number.isFinite(story.uniqueSourceCount)
        && story.uniqueSourceCount >= 0))
    && typeof story.category === 'string'
    && typeof story.threatLevel === 'string';
}

function isBriefSource(value: unknown): value is ServerBriefSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<ServerBriefSource>;
  return typeof source.title === 'string'
    && typeof source.source === 'string'
    && typeof source.url === 'string';
}

export function validateInsights(raw: unknown): ServerInsights | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Partial<ServerInsights>;
  if (typeof data.worldBrief !== 'string') return null;
  if (typeof data.briefProvider !== 'string') return null;
  if (data.status !== 'ok' && data.status !== 'degraded') return null;
  if (!Array.isArray(data.topStories) || data.topStories.length === 0 || !data.topStories.every(isInsightStory)) return null;
  if (typeof data.generatedAt !== 'string') return null;
  if (data.worldBriefSources !== undefined
    && (!Array.isArray(data.worldBriefSources) || !data.worldBriefSources.every(isBriefSource))) return null;
  if (data.briefStoryLines !== undefined
    && (!Array.isArray(data.briefStoryLines) || !data.briefStoryLines.every((line) => (
      line && typeof line === 'object'
      && typeof (line as { n?: number }).n === 'number'
      && Number.isFinite((line as { n: number }).n)
      && typeof (line as { text?: string }).text === 'string'
    )))) return null;
  if (!isFresh(data as ServerInsights)) return null;
  return data as ServerInsights;
}

export function getServerInsights(): ServerInsights | null {
  if (cached && isFresh(cached)) {
    return cached;
  }
  cached = null;

  const data = validateInsights(getHydratedData('insights'));
  if (data) cached = data;
  return data;
}

/**
 * On-demand refetch of the server-insights snapshot via the public fast-tier
 * bootstrap endpoint. Used by InsightsPanel when getServerInsights() returns
 * null because the bootstrap hydration cache is empty — typically:
 *   - mobile fast-tier abort on 4G (bootstrap.ts:179 — 1.2 s budget),
 *   - cached value went stale (>MAX_AGE_MS) with no second bootstrap fetch,
 *   - getHydratedData() was already consumed by an earlier failed validation
 *     (it deletes on read; insights-loader.ts validation drained the slot
 *     without caching, leaving subsequent reads with nothing).
 *
 * `insights` belongs to the fast tier. The exact `tier=fast&public=1` shape is
 * credentials-free and CDN-cached; the legacy single-key shape is not public.
 * Mirrors the AAIISentimentPanel fallback shape (AAIISentimentPanel.ts:147).
 *
 * Returns the validated insights on success, null on any failure (network,
 * timeout, validation). Caches the value module-locally on success so
 * subsequent getServerInsights() calls return it without re-fetching.
 */
export async function fetchServerInsights(timeoutMs = 5_000, force = false): Promise<ServerInsights | null> {
  if (!force && cached && isFresh(cached)) return cached;
  try {
    const resp = await fetch(toApiUrl('/api/bootstrap?tier=fast&public=1'), {
      signal: AbortSignal.timeout(timeoutMs),
      credentials: 'omit',
    });
    if (!resp.ok) return null;
    const payload = (await resp.json()) as { data?: { insights?: unknown } };
    const data = validateInsights(payload.data?.insights);
    if (data) cached = data;
    return data;
  } catch {
    return null;
  }
}

export function setServerInsights(data: ServerInsights): void {
  cached = data;
}

/** Test-only: reset module-local cache so suites can exercise the drain-once behavior. */
export function __resetServerInsightsCacheForTests(): void {
  cached = null;
}
