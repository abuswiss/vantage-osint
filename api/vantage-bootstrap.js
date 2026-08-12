import { getCorsHeaders, getPublicCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import {
  VANTAGE_BOOTSTRAP_PATH,
  classifyVantagePublicBootstrapUrl,
} from '../shared/vantage-public-bootstrap.js';

// No runtime override means Vercel's Node.js runtime. Keeping this facade in a
// separate function leaves canonical /api/bootstrap on its existing Edge path.
export const config = { maxDuration: 15 };

const CANONICAL_PUBLIC_BOOTSTRAP_ORIGIN = 'https://api.worldmonitor.app';
const CANONICAL_PUBLIC_BOOTSTRAP_TIMEOUT_MS = 8_000;
const CANONICAL_PUBLIC_BOOTSTRAP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CACHE_HEADERS = {
  fast: {
    browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
    cdn: 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900',
  },
  slow: {
    browser: 'max-age=300, stale-while-revalidate=600, stale-if-error=3600',
    cdn: 'public, s-maxage=7200, stale-while-revalidate=1800, stale-if-error=7200',
  },
  chinaDecisionSignals: {
    browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
    cdn: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900',
  },
};

let fetchCanonicalPublicBootstrap = (...args) => globalThis.fetch(...args);

function isVantagePublicMode(env = process.env) {
  const normalized = String(env.VANTAGE_PUBLIC_MODE ?? env.VITE_VANTAGE_PUBLIC_MODE ?? '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true';
}

function isCanonicalWorldMonitorHost(hostname) {
  return hostname === 'worldmonitor.app'
    || hostname === 'www.worldmonitor.app'
    || hostname === 'api.worldmonitor.app'
    || hostname.endsWith('.worldmonitor.app');
}

function unavailable(stage, upstreamStatus) {
  const diagnostic = { stage, runtime: 'node' };
  if (Number.isInteger(upstreamStatus)) diagnostic.upstreamStatus = upstreamStatus;
  console.warn('[vantage-bootstrap] canonical public read unavailable', diagnostic);
  return jsonResponse(
    { error: 'Bootstrap service temporarily unavailable' },
    503,
    {
      ...getPublicCorsHeaders(),
      'Cache-Control': 'no-store',
      'Retry-After': '5',
    },
  );
}

function notFound() {
  return jsonResponse(
    { error: 'Not found' },
    404,
    {
      ...getPublicCorsHeaders(),
      'Cache-Control': 'no-store',
    },
  );
}

function isCanonicalBootstrapPayload(value) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.data != null
    && typeof value.data === 'object'
    && !Array.isArray(value.data)
    && Array.isArray(value.missing)
    && value.missing.every((name) => typeof name === 'string');
}

function successHeaders(descriptor) {
  const profile = descriptor.kind === 'tier'
    ? CACHE_HEADERS[descriptor.tier]
    : CACHE_HEADERS[descriptor.key] ?? CACHE_HEADERS.fast;
  return {
    ...getPublicCorsHeaders(),
    'Cache-Control': profile.browser,
    'CDN-Cache-Control': profile.cdn,
  };
}

export async function handleVantageBootstrap(req) {
  if (isDisallowedOrigin(req)) {
    return new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const incomingUrl = new URL(req.url);
  if (!isVantagePublicMode() || isCanonicalWorldMonitorHost(incomingUrl.hostname)) return notFound();

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: getCorsHeaders(req) });
  }

  const descriptor = classifyVantagePublicBootstrapUrl(incomingUrl, {
    method: req.method,
    expectedPath: VANTAGE_BOOTSTRAP_PATH,
  });
  if (!descriptor) return notFound();

  const canonicalUrl = new URL(`/api/bootstrap${incomingUrl.search}`, CANONICAL_PUBLIC_BOOTSTRAP_ORIGIN);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CANONICAL_PUBLIC_BOOTSTRAP_TIMEOUT_MS);

  try {
    const upstream = await fetchCanonicalPublicBootstrap(canonicalUrl.href, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'User-Agent': CANONICAL_PUBLIC_BOOTSTRAP_USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!upstream.ok) return unavailable('upstream_status', upstream.status);

    let payload;
    try {
      payload = await upstream.json();
    } catch {
      return unavailable('invalid_json');
    }
    if (!isCanonicalBootstrapPayload(payload)) return unavailable('invalid_payload');

    return jsonResponse(payload, 200, successHeaders(descriptor));
  } catch {
    return unavailable(controller.signal.aborted ? 'timeout' : 'fetch_error');
  } finally {
    clearTimeout(timeout);
  }
}

export default { fetch: handleVantageBootstrap };

export const __testing__ = {
  resetCanonicalPublicBootstrapFetchForTests() {
    fetchCanonicalPublicBootstrap = (...args) => globalThis.fetch(...args);
  },
  setCanonicalPublicBootstrapFetchForTests(fetchImpl) {
    fetchCanonicalPublicBootstrap = fetchImpl;
  },
};
