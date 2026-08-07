import { getPublicCorsHeaders } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { BOOTSTRAP_CACHE_KEYS } from './_bootstrap-tier-keys.js';
import { redisPipeline } from './_upstash-json.js';

export const config = { runtime: 'edge' };

const CACHE_CHECKS = Object.freeze([
  { id: 'news', key: 'news:digest:v1:full:en', maxAgeMs: 10 * 60_000 },
  { id: 'insights', key: BOOTSTRAP_CACHE_KEYS.insights, maxAgeMs: 45 * 60_000 },
  { id: 'risk', key: BOOTSTRAP_CACHE_KEYS.riskScores, maxAgeMs: 45 * 60_000 },
]);

function parseRedisValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function timestampFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload.generatedAt,
    payload.fetchedAt,
    payload.updatedAt,
    payload.issuedAt,
    payload.timestamp,
    payload._seed?.fetchedAt,
    payload.data?.generatedAt,
    payload.data?.fetchedAt,
    payload.data?.updatedAt,
    payload.data?.issuedAt,
  ];
  for (const value of candidates) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const timestampMs = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isFinite(timestampMs)) return timestampMs;
  }
  return null;
}

export function classifyCacheEntry(entry, maxAgeMs, nowMs = Date.now()) {
  if (!entry || Object.prototype.hasOwnProperty.call(entry, 'error')) {
    return { status: 'error', ageSeconds: null };
  }
  if (!Object.prototype.hasOwnProperty.call(entry, 'result')) {
    return { status: 'error', ageSeconds: null };
  }
  if (entry.result === null) return { status: 'missing', ageSeconds: null };

  const timestampMs = timestampFromPayload(parseRedisValue(entry.result));
  if (timestampMs === null) return { status: 'ready', ageSeconds: null };
  const ageMs = Math.max(0, nowMs - timestampMs);
  return {
    status: ageMs <= maxAgeMs ? 'ready' : 'stale',
    ageSeconds: Math.round(ageMs / 1_000),
  };
}

export function relayHealthUrl(wsRelayUrl) {
  if (!wsRelayUrl) return null;
  try {
    const url = new URL(wsRelayUrl);
    if (url.protocol === 'wss:') url.protocol = 'https:';
    else if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.pathname = '/health';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function summarizeRelayHealth(payload) {
  if (!payload || typeof payload !== 'object') {
    return { status: 'unavailable', air: 'unavailable', ships: 'unavailable' };
  }
  const relayStatus = payload.status === 'ok'
    ? (payload.ingestion?.status === 'degraded' ? 'degraded' : 'ready')
    : 'unavailable';
  const aviationCoverage = payload.ingestion?.aviation?.coverage?.status;
  const air = aviationCoverage === 'degraded'
    ? 'degraded'
    : payload.status === 'ok' ? 'ready' : 'unavailable';
  const aisConnected = payload.ingestion?.aisSnapshot?.connected ?? payload.connected;
  const ships = aisConnected === true
    ? 'ready'
    : payload.status === 'ok' ? 'waiting' : 'unavailable';
  return { status: relayStatus, air, ships };
}

export async function collectVantageHealth(
  dependencies = { pipeline: redisPipeline, fetch: globalThis.fetch, env: process.env },
  nowMs = Date.now(),
) {
  const commands = [['PING'], ...CACHE_CHECKS.map(({ key }) => ['GET', key])];
  const redisResults = await dependencies.pipeline(commands, 2_500);
  const redisEntry = redisResults?.[0];
  const redisReady = redisEntry?.result === 'PONG';

  const data = Object.fromEntries(CACHE_CHECKS.map((check, index) => [
    check.id,
    classifyCacheEntry(redisResults?.[index + 1], check.maxAgeMs, nowMs),
  ]));

  let relay = { status: 'not-configured', air: 'not-configured', ships: 'not-configured' };
  const healthUrl = relayHealthUrl(dependencies.env.WS_RELAY_URL);
  if (healthUrl) {
    try {
      const response = await dependencies.fetch(healthUrl, {
        headers: { 'User-Agent': 'vantage-health/1.0' },
        signal: AbortSignal.timeout(2_500),
      });
      relay = response.ok
        ? summarizeRelayHealth(await response.json())
        : { status: 'unavailable', air: 'unavailable', ships: 'unavailable' };
    } catch {
      relay = { status: 'unavailable', air: 'unavailable', ships: 'unavailable' };
    }
  }

  const degraded = !redisReady
    || Object.values(data).some((check) => check.status !== 'ready')
    || relay.status !== 'ready'
    || relay.air !== 'ready'
    || relay.ships !== 'ready';

  return {
    status: !redisReady ? 'unavailable' : degraded ? 'degraded' : 'ready',
    checkedAt: new Date(nowMs).toISOString(),
    services: {
      redis: redisReady ? 'ready' : 'unavailable',
      ...data,
      relay,
    },
  };
}

export default async function handler(req) {
  const headers = {
    ...getPublicCorsHeaders('GET, OPTIONS'),
    'Cache-Control': 'no-store',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, headers);

  const health = await collectVantageHealth();
  return jsonResponse(health, health.status === 'unavailable' ? 503 : 200, headers);
}
