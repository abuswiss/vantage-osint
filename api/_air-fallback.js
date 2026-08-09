import { jsonResponse } from './_json-response.js';

const ADSB_LOL_MILITARY_URL = 'https://api.adsb.lol/v2/mil';
const UPSTREAM_TIMEOUT_MS = 6_500;

function finiteSearchNumber(search, name) {
  const raw = search.get(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The legacy OpenSky-compatible route is only consumed as a live military-air
 * map feed. Normalize an optional bbox so the provider fallback can preserve
 * the same response contract without exposing a generic fetch proxy.
 */
export function normalizeAirFallbackBbox(requestUrl) {
  const source = new URL(requestUrl);
  const names = ['lamin', 'lomin', 'lamax', 'lomax'];
  const hasAny = names.some((name) => source.searchParams.has(name));
  if (!hasAny) return { bbox: null };

  const values = Object.fromEntries(
    names.map((name) => [name, finiteSearchNumber(source.searchParams, name)]),
  );
  if (names.some((name) => values[name] === null)) {
    return { error: 'Provide all bbox params: lamin,lomin,lamax,lomax' };
  }

  const { lamin, lomin, lamax, lomax } = values;
  if (lamin < -90 || lamax > 90 || lomin < -180 || lomax > 180) {
    return { error: 'Bbox out of range' };
  }
  if (lamin > lamax || lomin > lomax) return { error: 'Invalid bbox ordering' };
  return { bbox: { lamin, lomin, lamax, lomax } };
}

function isInsideBbox(lat, lon, bbox) {
  return !bbox
    || (lat >= bbox.lamin && lat <= bbox.lamax && lon >= bbox.lomin && lon <= bbox.lomax);
}

/** Convert ADSB.lol's current military row to the OpenSky state-vector shape. */
export function adsbLolAircraftToOpenSkyState(aircraft, nowSeconds = Math.floor(Date.now() / 1_000)) {
  const hex = String(aircraft?.hex || '').replace(/~/g, '').trim().toLowerCase();
  const lat = Number(aircraft?.lat);
  const lon = Number(aircraft?.lon);
  if (!hex || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const seenSeconds = Math.max(0, Number(aircraft?.seen) || 0);
  const lastContact = Math.max(0, Math.floor(nowSeconds - seenSeconds));
  const altitudeFeet = typeof aircraft?.alt_baro === 'number' ? aircraft.alt_baro : null;
  const speedKnots = Number(aircraft?.gs);
  const verticalRateFeetPerMinute = Number(aircraft?.baro_rate ?? aircraft?.geom_rate);

  return [
    hex,
    String(aircraft?.flight || '').trim() || null,
    '',
    lastContact,
    lastContact,
    lon,
    lat,
    altitudeFeet === null ? null : altitudeFeet * 0.3048,
    aircraft?.alt_baro === 'ground',
    Number.isFinite(speedKnots) ? speedKnots / 1.94384 : null,
    Number.isFinite(Number(aircraft?.track)) ? Number(aircraft.track) : null,
    Number.isFinite(verticalRateFeetPerMinute) ? verticalRateFeetPerMinute / 196.85 : null,
    null,
    null,
    String(aircraft?.squawk || '') || null,
    false,
    0,
  ];
}

async function fetchWithDeadline(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Independent live-air fallback for cloud environments where OpenSky blocks
 * the OAuth/data egress path. ADSB.lol's military feed is the same resilient
 * source used by the canonical military-flight RPC, so browser and desktop
 * clients degrade to real positions rather than a credential-shaped timeout.
 */
export async function fetchAirFallback(req, corsHeaders, overrides = {}) {
  const normalized = normalizeAirFallbackBbox(req.url);
  if (normalized.error) {
    return jsonResponse({ error: normalized.error, states: [] }, 400, corsHeaders);
  }

  const fetchImpl = overrides.fetchImpl ?? globalThis.fetch;
  const now = overrides.now ?? Date.now;
  try {
    const response = await fetchWithDeadline(
      fetchImpl,
      ADSB_LOL_MILITARY_URL,
      {
        headers: { Accept: 'application/json', 'User-Agent': 'WorldMonitor/1.0' },
        cache: 'no-store',
      },
      overrides.timeoutMs ?? UPSTREAM_TIMEOUT_MS,
    );
    if (!response.ok) {
      return jsonResponse(
        { error: 'Live air fallback request failed', upstreamStatus: response.status, states: [] },
        response.status === 429 ? 429 : 502,
        corsHeaders,
      );
    }

    const payload = await response.json();
    const nowSeconds = Math.floor(now() / 1_000);
    const states = (Array.isArray(payload?.ac) ? payload.ac : [])
      .map((aircraft) => adsbLolAircraftToOpenSkyState(aircraft, nowSeconds))
      .filter((state) => state && isInsideBbox(state[6], state[5], normalized.bbox));

    return jsonResponse({ time: nowSeconds, states }, 200, {
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=30, stale-if-error=300',
      'X-Data-Source': 'adsb-lol-military',
      ...corsHeaders,
    });
  } catch (error) {
    const isTimeout = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    return jsonResponse(
      {
        error: isTimeout ? 'Live air fallback timeout' : 'Live air fallback request failed',
        states: [],
      },
      isTimeout ? 504 : 502,
      corsHeaders,
    );
  }
}
