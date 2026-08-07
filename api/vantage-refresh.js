import { acquireLockSafely, releaseLock } from '../scripts/_seed-utils.mjs';
import { seedInsightsOnce } from '../scripts/seed-insights.mjs';
import { timingSafeEqualSecret } from './_crypto.js';
import { redisPipeline } from './_upstash-json.js';

export const config = { maxDuration: 300 };

const DEFAULT_PUBLIC_BASE_URL = 'https://vantage-osint.vercel.app';
const FRESHNESS_CLOCK_SKEW_MS = 5_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const RISK_MAX_AGE_MS = 15 * 60_000;
export const VANTAGE_REFRESH_LIMITS = Object.freeze({
  maxDurationMs: config.maxDuration * 1_000,
  deadlineMs: 280_000,
  lockTtlMs: 6 * 60_000,
  minInsightsBudgetMs: 120_000,
  insightsRefreshIntervalMs: 15 * 60_000,
});
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36';

function headerValue(req, name) {
  if (typeof req?.headers?.get === 'function') return req.headers.get(name) || '';
  const value = req?.headers?.[name] ?? req?.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  if (typeof res?.status === 'function' && typeof res?.json === 'function') {
    res.setHeader?.('Cache-Control', 'no-store');
    return res.status(status).json(payload);
  }
  res.statusCode = status;
  res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
  res.setHeader?.('Cache-Control', 'no-store');
  res.end?.(body);
  return undefined;
}

function requiredEnv(env, name) {
  const value = env?.[name];
  if (!value) throw new Error(`Missing required refresh configuration: ${name}`);
  return value;
}

function publicBaseUrl(env) {
  const configured = env?.VANTAGE_PUBLIC_URL || DEFAULT_PUBLIC_BASE_URL;
  const parsed = new URL(configured);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('VANTAGE_PUBLIC_URL must use HTTP or HTTPS');
  }
  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function parseJsonResponse(response, label) {
  if (!response.ok) throw new Error(`${label} refresh returned HTTP ${response.status}`);
  return response.json();
}

function assertFreshTimestamp(value, startedAt, nowMs, label) {
  const generatedAt = Date.parse(value);
  if (
    !Number.isFinite(generatedAt)
    || generatedAt < startedAt - FRESHNESS_CLOCK_SKEW_MS
    || generatedAt > nowMs + MAX_FUTURE_SKEW_MS
  ) {
    throw new Error(`${label} refresh did not publish a fresh snapshot`);
  }
  return generatedAt;
}

export function unwrapStoredInsights(result) {
  if (result === null || result === undefined) return null;
  const stored = typeof result === 'string' ? JSON.parse(result) : result;
  return {
    seed: stored?._seed ?? null,
    payload: stored?.data ?? stored,
  };
}

async function readRedisValue(env, key, fetchFn = globalThis.fetch) {
  const redisUrl = requiredEnv(env, 'UPSTASH_REDIS_REST_URL');
  const redisToken = requiredEnv(env, 'UPSTASH_REDIS_REST_TOKEN');
  const response = await fetchFn(`${redisUrl}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${redisToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Redis verification returned HTTP ${response.status}`);
  const body = await response.json();
  if (body?.result === null || body?.result === undefined) return null;
  return typeof body.result === 'string' ? JSON.parse(body.result) : body.result;
}

export async function readPublishedInsights(env, fetchFn = globalThis.fetch) {
  const stored = await readRedisValue(env, 'news:insights:v1', fetchFn);
  if (stored === null) return null;
  return unwrapStoredInsights(stored);
}

async function refreshNews({ baseUrl, relayKey, fetchFn, now, runId }) {
  const startedAt = now();
  const url = new URL('/api/news/v1/list-feed-digest', baseUrl);
  url.searchParams.set('variant', 'full');
  url.searchParams.set('lang', 'en');
  url.searchParams.set('public', '1');
  url.searchParams.set('refresh', runId);
  const response = await fetchFn(url, {
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      Origin: baseUrl,
      'Cache-Control': 'no-cache',
      'X-WorldMonitor-Key': relayKey,
    },
    signal: AbortSignal.timeout(50_000),
  });
  const digest = await parseJsonResponse(response, 'News');
  const categories = digest?.categories;
  const categoryCount = Array.isArray(categories)
    ? categories.length
    : categories && typeof categories === 'object' ? Object.keys(categories).length : 0;
  if (categoryCount < 3) throw new Error('News refresh returned fewer than three categories');
  const buckets = Array.isArray(categories) ? categories : Object.values(categories || {});
  const itemCount = buckets.reduce((count, bucket) => {
    if (Array.isArray(bucket)) return count + bucket.length;
    return count + (Array.isArray(bucket?.items) ? bucket.items.length : 0);
  }, 0);
  if (itemCount === 0) throw new Error('News refresh returned no items');
  assertFreshTimestamp(digest?.generatedAt, startedAt, now(), 'News');
  return { generatedAt: digest.generatedAt, categoryCount, itemCount };
}

async function warmAndVerifyRisk({ baseUrl, relayKey, fetchFn, readRiskMeta, now }) {
  const url = new URL('/api/intelligence/v1/get-risk-scores', baseUrl);
  const response = await fetchFn(url, {
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      Origin: baseUrl,
      'Cache-Control': 'no-cache',
      'X-WorldMonitor-Key': relayKey,
    },
    signal: AbortSignal.timeout(65_000),
  });
  const risk = await parseJsonResponse(response, 'Risk');
  if (!Array.isArray(risk?.ciiScores) || risk.ciiScores.length === 0) {
    throw new Error('Risk refresh returned no CII scores');
  }
  if (risk.degraded === true || risk.stale === true) {
    throw new Error('Risk warm returned degraded or stale scores');
  }
  const meta = await readRiskMeta();
  const fetchedAt = Number(meta?.fetchedAt);
  const nowMs = now();
  if (
    !Number.isFinite(fetchedAt)
    || fetchedAt < nowMs - RISK_MAX_AGE_MS
    || fetchedAt > nowMs + MAX_FUTURE_SKEW_MS
  ) {
    throw new Error('Risk warm did not verify a recent source snapshot');
  }
  return {
    mode: 'warm-verified',
    scoreCount: risk.ciiScores.length,
    ageSeconds: Math.max(0, Math.round((nowMs - fetchedAt) / 1_000)),
  };
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function verifyInsightsSnapshot(snapshot, freshAfterMs, nowMs) {
  const seed = snapshot?.seed;
  const payload = snapshot?.payload;
  if (seed?.state !== 'OK' || !Number.isFinite(seed?.fetchedAt) || seed.recordCount <= 0) return null;
  if (payload?.status !== 'ok') return null;
  if (!Array.isArray(payload.topStories) || payload.topStories.length === 0) return null;
  if (!Array.isArray(payload.worldBriefSources) || payload.worldBriefSources.length === 0) return null;
  if (typeof payload.worldBrief !== 'string' || payload.worldBrief.trim().length === 0) return null;
  if (!/\[\d+\]/.test(payload.worldBrief)) return null;
  if (payload.worldBriefSources.some((source) => !validHttpUrl(source?.url))) return null;

  const briefText = [
    payload.worldBrief,
    ...(Array.isArray(payload.briefStoryLines)
      ? payload.briefStoryLines.map((line) => typeof line === 'string' ? line : line?.text || '')
      : []),
  ].join('\n');
  const citationIndexes = [...briefText.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
  if (
    citationIndexes.length === 0
    || citationIndexes.some((index) => !Number.isInteger(index)
      || index < 1
      || index > payload.worldBriefSources.length)
  ) return null;

  try {
    assertFreshTimestamp(payload.generatedAt, freshAfterMs, nowMs, 'Insights');
  } catch {
    return null;
  }
  if (
    seed.fetchedAt < freshAfterMs - FRESHNESS_CLOCK_SKEW_MS
    || seed.fetchedAt > nowMs + MAX_FUTURE_SKEW_MS
  ) return null;
  return {
    generatedAt: payload.generatedAt,
    storyCount: payload.topStories.length,
    citationCount: payload.worldBriefSources.length,
    provider: payload.briefProvider || 'unknown',
  };
}

// Sorted-set archive of verified world-brief snapshots, consumed by
// api/brief-history.js (which duplicates this key on purpose: importing this
// module there would drag the seed scripts into an edge bundle).
// Member = trimmed JSON snapshot, score = Date.parse(generatedAt).
const INSIGHTS_HISTORY_KEY = 'news:insights:history:v1';
const INSIGHTS_HISTORY_MAX_ENTRIES = 400;

/** Trim a verified insights payload down to what brief history/diffs need. */
export function buildBriefArchiveEntry(payload) {
  return {
    generatedAt: payload.generatedAt,
    worldBrief: payload.worldBrief,
    ...(Array.isArray(payload.briefStoryLines) && payload.briefStoryLines.length > 0
      ? { briefStoryLines: payload.briefStoryLines.map((line) => (
        typeof line === 'string' ? line : { n: line?.n ?? null, text: line?.text ?? '' }
      )) }
      : {}),
    worldBriefSources: (Array.isArray(payload.worldBriefSources) ? payload.worldBriefSources : [])
      .map((source, i) => ({
        index: Number.isFinite(source?.index) ? source.index : i + 1,
        source: source?.source ?? '',
        title: source?.title ?? '',
        url: source?.url ?? '',
      })),
    clusterCount: Number.isFinite(payload.clusterCount) ? payload.clusterCount : null,
    ...(payload.provenance && typeof payload.provenance === 'object'
      ? { provenance: payload.provenance }
      : {}),
  };
}

/**
 * Best-effort archive of a verified snapshot into the history sorted set.
 * Dedupes on generatedAt (skips when the newest archived score matches) and
 * caps the set at INSIGHTS_HISTORY_MAX_ENTRIES by dropping the oldest.
 * MUST never throw: an archive failure cannot be allowed to fail the refresh.
 */
export async function archiveBriefSnapshot(payload, pipeline = redisPipeline) {
  try {
    const generatedAtMs = Date.parse(payload?.generatedAt);
    if (!Number.isFinite(generatedAtMs)) {
      console.warn('[vantage-refresh] brief archive skipped: snapshot has no parseable generatedAt');
      return { archived: false, reason: 'invalid_generated_at' };
    }

    const latest = await pipeline([['ZRANGE', INSIGHTS_HISTORY_KEY, '-1', '-1', 'WITHSCORES']]);
    if (!latest) {
      console.warn('[vantage-refresh] brief archive skipped: Redis pipeline unavailable');
      return { archived: false, reason: 'redis_unavailable' };
    }
    const latestEntry = latest[0]?.result;
    const latestScore = Array.isArray(latestEntry) && latestEntry.length >= 2
      ? Number(latestEntry[1])
      : null;
    if (latestScore === generatedAtMs) return { archived: false, reason: 'duplicate' };

    const member = JSON.stringify(buildBriefArchiveEntry(payload));
    const results = await pipeline([
      ['ZADD', INSIGHTS_HISTORY_KEY, String(generatedAtMs), member],
      // Keep only the newest INSIGHTS_HISTORY_MAX_ENTRIES members.
      ['ZREMRANGEBYRANK', INSIGHTS_HISTORY_KEY, '0', String(-(INSIGHTS_HISTORY_MAX_ENTRIES + 1))],
    ]);
    if (!results || results.some((entry) => entry && Object.prototype.hasOwnProperty.call(entry, 'error'))) {
      console.warn('[vantage-refresh] brief archive write failed');
      return { archived: false, reason: 'write_failed' };
    }
    return { archived: true };
  } catch (error) {
    console.warn('[vantage-refresh] brief archive failed', error);
    return { archived: false, reason: 'exception' };
  }
}

export async function runVantageRefresh(dependencies = {}) {
  const env = dependencies.env || process.env;
  const fetchFn = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || Date.now;
  const acquire = dependencies.acquireLock || acquireLockSafely;
  const release = dependencies.releaseLock || releaseLock;
  const seed = dependencies.seedInsights || seedInsightsOnce;
  const readInsights = dependencies.readInsights
    || (() => readPublishedInsights(env, fetchFn));
  const readRiskMeta = dependencies.readRiskMeta
    || (() => readRedisValue(env, 'seed-meta:intelligence:risk-scores', fetchFn));
  const relayKey = requiredEnv(env, 'WORLDMONITOR_RELAY_KEY');
  requiredEnv(env, 'UPSTASH_REDIS_REST_URL');
  requiredEnv(env, 'UPSTASH_REDIS_REST_TOKEN');

  const baseUrl = dependencies.baseUrl || publicBaseUrl(env);
  const startedAt = now();
  const deadlineAt = startedAt + VANTAGE_REFRESH_LIMITS.deadlineMs;
  const runId = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
  const lockDomain = 'vantage:refresh';
  const lock = await acquire(lockDomain, runId, VANTAGE_REFRESH_LIMITS.lockTtlMs, { label: lockDomain });
  if (lock.skipped) throw new Error('Refresh orchestrator could not acquire its Redis lock');
  if (!lock.locked) return { status: 'skipped', reason: 'already_running' };

  try {
    const [news, risk] = await Promise.all([
      refreshNews({ baseUrl, relayKey, fetchFn, now, runId }),
      warmAndVerifyRisk({ baseUrl, relayKey, fetchFn, readRiskMeta, now }),
    ]);

    let snapshot = await readInsights();
    let insights = verifyInsightsSnapshot(
      snapshot,
      startedAt - VANTAGE_REFRESH_LIMITS.insightsRefreshIntervalMs,
      now(),
    );
    let seedStatus = 'not_due';
    if (!insights) {
      if (now() > deadlineAt - VANTAGE_REFRESH_LIMITS.minInsightsBudgetMs) {
        throw new Error('Insufficient execution budget remains for cited insights');
      }
      const seedResult = await seed({
        withRetry: async (operation) => operation(),
      });
      seedStatus = seedResult?.status || 'unknown';
      snapshot = await readInsights();
      insights = verifyInsightsSnapshot(snapshot, startedAt, now());
    }
    if (!insights) throw new Error('Cited insights did not publish a fresh grounded snapshot');
    if (now() > deadlineAt) throw new Error('Refresh exceeded its execution deadline');

    // Best-effort history archive of the verified snapshot; never fails the refresh.
    await archiveBriefSnapshot(snapshot?.payload, dependencies.pipeline || redisPipeline);

    return {
      status: 'ok',
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(now()).toISOString(),
      news,
      risk,
      insights: { ...insights, seedStatus },
    };
  } finally {
    await release(lockDomain, runId);
  }
}

export async function handleVantageRefresh(req, res, dependencies = {}) {
  if (req?.method !== 'GET') {
    res.setHeader?.('Allow', 'GET');
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const env = dependencies.env || process.env;
  const secret = env.CRON_SECRET || '';
  const auth = headerValue(req, 'authorization');
  const safeEqual = dependencies.timingSafeEqual || timingSafeEqualSecret;
  if (!secret || !(await safeEqual(auth, `Bearer ${secret}`))) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  try {
    const refresh = dependencies.runVantageRefresh || runVantageRefresh;
    const result = await refresh({ ...dependencies, env });
    return sendJson(res, result.status === 'skipped' ? 202 : 200, result);
  } catch (error) {
    console.error('[vantage-refresh] failed', error);
    return sendJson(res, 500, { error: 'Refresh failed' });
  }
}

export default async function handler(req, res) {
  return handleVantageRefresh(req, res);
}
