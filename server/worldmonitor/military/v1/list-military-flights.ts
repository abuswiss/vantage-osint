import type {
  ServerContext,
  ListMilitaryFlightsRequest,
  ListMilitaryFlightsResponse,
  MilitaryAircraftType,
  MilitaryOperator,
  MilitaryConfidence,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { isMilitaryCallsign, isMilitaryHex, detectAircraftType, UPSTREAM_TIMEOUT_MS } from './_shared';
import { cachedFetchJson, getRawJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/relay';

const REDIS_CACHE_KEY = 'military:flights:v1';
const REDIS_CACHE_TTL = 120; // 2 min — positions stay useful without hammering the shared upstream
const REDIS_STALE_KEY = 'military:flights:stale:v1';
const ADSB_LOL_MILITARY_URL = 'https://api.adsb.lol/v2/mil';

/** Snap a coordinate to a grid step so nearby bbox values share cache entries. */
const quantize = (v: number, step: number) => Math.round(v / step) * step;
const BBOX_GRID_STEP = 1; // 1-degree grid (~111 km at equator)

interface RequestBounds {
  south: number;
  north: number;
  west: number;
  east: number;
}


function normalizeBounds(req: ListMilitaryFlightsRequest): RequestBounds {
  return {
    south: Math.min(req.swLat, req.neLat),
    north: Math.max(req.swLat, req.neLat),
    west: Math.min(req.swLon, req.neLon),
    east: Math.max(req.swLon, req.neLon),
  };
}

function filterFlightsToBounds(
  flights: ListMilitaryFlightsResponse['flights'],
  bounds: RequestBounds,
): ListMilitaryFlightsResponse['flights'] {
  return flights.filter((flight) => {
    const lat = flight.location?.latitude;
    const lon = flight.location?.longitude;
    if (lat == null || lon == null) return false;
    return lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east;
  });
}

// Pagination is bounded on every request: page_size documents a 1-100 range,
// and 0 / omitted / malformed / out-of-range inputs fall back to the default
// so the public endpoint never streams an unbounded response. The cursor is an
// opaque decimal offset into the exact-bbox-filtered result; empty or malformed
// cursors start at the first page. Internal callers that need the full dataset
// follow next_cursor (see src/services/military-flights.ts:fetchViaProto).
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;

function resolvePageSize(pageSize: number | undefined): number {
  if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(pageSize, MAX_PAGE_SIZE);
}

function resolveOffset(cursor: string | undefined): number {
  if (typeof cursor !== 'string' || !/^\d+$/.test(cursor)) return 0;
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

function emptyResponse(): ListMilitaryFlightsResponse {
  return { flights: [], clusters: [], pagination: { nextCursor: '', totalCount: 0 } };
}

// Filter the cached quantized-cell snapshot to the exact request bbox, THEN
// page it. Ordering must not depend on page size or cursor, so the shared
// snapshot's stable order is preserved and only sliced here.
function paginateResponse(
  flights: ListMilitaryFlightsResponse['flights'],
  clusters: ListMilitaryFlightsResponse['clusters'],
  bounds: RequestBounds,
  req: ListMilitaryFlightsRequest,
): ListMilitaryFlightsResponse {
  const filtered = filterFlightsToBounds(flights, bounds);
  const pageSize = resolvePageSize(req.pageSize);
  const offset = resolveOffset(req.cursor);
  const page = filtered.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < filtered.length ? String(nextOffset) : '';
  return {
    flights: page,
    clusters: clusters ?? [],
    pagination: { nextCursor, totalCount: filtered.length },
  };
}

const AIRCRAFT_TYPE_MAP: Record<string, string> = {
  tanker: 'MILITARY_AIRCRAFT_TYPE_TANKER',
  awacs: 'MILITARY_AIRCRAFT_TYPE_AWACS',
  transport: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
  reconnaissance: 'MILITARY_AIRCRAFT_TYPE_RECONNAISSANCE',
  drone: 'MILITARY_AIRCRAFT_TYPE_DRONE',
  bomber: 'MILITARY_AIRCRAFT_TYPE_BOMBER',
  fighter: 'MILITARY_AIRCRAFT_TYPE_FIGHTER',
  helicopter: 'MILITARY_AIRCRAFT_TYPE_HELICOPTER',
  vip: 'MILITARY_AIRCRAFT_TYPE_VIP',
  special_ops: 'MILITARY_AIRCRAFT_TYPE_SPECIAL_OPS',
};

const OPERATOR_MAP: Record<string, string> = {
  usaf: 'MILITARY_OPERATOR_USAF',
  raf: 'MILITARY_OPERATOR_RAF',
  faf: 'MILITARY_OPERATOR_FAF',
  gaf: 'MILITARY_OPERATOR_GAF',
  iaf: 'MILITARY_OPERATOR_IAF',
  nato: 'MILITARY_OPERATOR_NATO',
  other: 'MILITARY_OPERATOR_OTHER',
};

const CONFIDENCE_MAP: Record<string, string> = {
  high: 'MILITARY_CONFIDENCE_HIGH',
  medium: 'MILITARY_CONFIDENCE_MEDIUM',
  low: 'MILITARY_CONFIDENCE_LOW',
};

interface StaleFlight {
  id?: string;
  callsign?: string;
  hexCode?: string;
  registration?: string;
  aircraftType?: string;
  aircraftModel?: string;
  operator?: string;
  operatorCountry?: string;
  lat?: number | null;
  lon?: number | null;
  altitude?: number;
  heading?: number;
  speed?: number;
  verticalRate?: number;
  onGround?: boolean;
  squawk?: string;
  origin?: string;
  destination?: string;
  lastSeenMs?: number;
  firstSeenMs?: number;
  confidence?: string;
  isInteresting?: boolean;
  note?: string;
}

interface StalePayload {
  flights?: StaleFlight[];
  fetchedAt?: number;
}

interface AdsbLolAircraft {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | 'ground';
  gs?: number;
  track?: number;
  baro_rate?: number;
  geom_rate?: number;
  squawk?: string;
  seen?: number;
}

interface AdsbLolMilitaryPayload {
  ac?: AdsbLolAircraft[];
}

/**
 * Convert ADSB.lol's dedicated military feed into the canonical flight shape.
 * The endpoint already filters to aircraft carrying its military database flag;
 * local callsign/type heuristics enrich the row but do not second-guess that
 * upstream membership. Units on ADSB.lol are feet, knots and feet/minute, which
 * match the protobuf contract directly.
 */
export function mapAdsbLolMilitaryAircraft(
  aircraft: AdsbLolAircraft[],
  nowMs = Date.now(),
): ListMilitaryFlightsResponse['flights'] {
  const flights: ListMilitaryFlightsResponse['flights'] = [];
  const seenHex = new Set<string>();
  for (const raw of aircraft) {
    const hex = String(raw?.hex || '').replace(/~/g, '').trim().toUpperCase();
    const lat = Number(raw?.lat);
    const lon = Number(raw?.lon);
    if (!hex || seenHex.has(hex) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180 || raw.alt_baro === 'ground') continue;
    seenHex.add(hex);

    const callsign = String(raw.flight || '').trim();
    const aircraftType = detectAircraftType(callsign);
    const seenSeconds = Number(raw.seen);
    const lastSeenAt = Number.isFinite(seenSeconds)
      ? Math.max(0, nowMs - Math.max(0, seenSeconds) * 1_000)
      : nowMs;
    const isInteresting = ['bomber', 'reconnaissance', 'awacs', 'drone'].includes(aircraftType);

    flights.push({
      id: `adsblol-${hex}`,
      callsign: callsign || `UNKN-${hex.slice(0, 4)}`,
      hexCode: hex,
      registration: String(raw.r || ''),
      aircraftType: (AIRCRAFT_TYPE_MAP[aircraftType] || 'MILITARY_AIRCRAFT_TYPE_UNKNOWN') as MilitaryAircraftType,
      aircraftModel: String(raw.t || ''),
      operator: 'MILITARY_OPERATOR_OTHER',
      operatorCountry: '',
      location: { latitude: lat, longitude: lon },
      altitude: typeof raw.alt_baro === 'number' ? raw.alt_baro : 0,
      heading: Number.isFinite(Number(raw.track)) ? Number(raw.track) : 0,
      speed: Number.isFinite(Number(raw.gs)) ? Number(raw.gs) : 0,
      verticalRate: Number.isFinite(Number(raw.baro_rate ?? raw.geom_rate))
        ? Number(raw.baro_rate ?? raw.geom_rate)
        : 0,
      onGround: false,
      squawk: String(raw.squawk || ''),
      origin: '',
      destination: '',
      lastSeenAt,
      firstSeenAt: 0,
      confidence: 'MILITARY_CONFIDENCE_MEDIUM',
      isInteresting,
      note: 'ADSB.lol military feed',
      enrichment: undefined,
    });
  }
  return flights;
}

async function fetchAdsbLolMilitaryFlights(): Promise<ListMilitaryFlightsResponse['flights'] | null> {
  try {
    const response = await fetch(ADSB_LOL_MILITARY_URL, {
      headers: { Accept: 'application/json', 'User-Agent': 'WorldMonitor/1.0' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return null;
    const payload = await response.json() as AdsbLolMilitaryPayload;
    const flights = mapAdsbLolMilitaryAircraft(Array.isArray(payload.ac) ? payload.ac : []);
    return flights.length > 0 ? flights : null;
  } catch {
    return null;
  }
}

/**
 * Convert the seed cron's app-shape flight (flat lat/lon, lowercase enums,
 * lastSeenMs) into the proto shape (nested GeoCoordinates, enum strings,
 * lastSeenAt). Mirrors the inverse of src/services/military-flights.ts:mapProtoFlight.
 * hexCode is canonicalized to uppercase per the invariant documented on
 * MilitaryFlight.hex_code in military_flight.proto.
 */
function staleToProto(f: StaleFlight): ListMilitaryFlightsResponse['flights'][number] | null {
  if (f.lat == null || f.lon == null) return null;
  const icao = (f.hexCode || f.id || '').toUpperCase();
  if (!icao) return null;
  return {
    id: icao,
    callsign: (f.callsign || '').trim(),
    hexCode: icao,
    registration: f.registration || '',
    aircraftType: (AIRCRAFT_TYPE_MAP[f.aircraftType || ''] || 'MILITARY_AIRCRAFT_TYPE_UNKNOWN') as MilitaryAircraftType,
    aircraftModel: f.aircraftModel || '',
    operator: (OPERATOR_MAP[f.operator || ''] || 'MILITARY_OPERATOR_OTHER') as MilitaryOperator,
    operatorCountry: f.operatorCountry || '',
    location: { latitude: f.lat, longitude: f.lon },
    altitude: f.altitude ?? 0,
    heading: f.heading ?? 0,
    speed: f.speed ?? 0,
    verticalRate: f.verticalRate ?? 0,
    onGround: f.onGround ?? false,
    squawk: f.squawk || '',
    origin: f.origin || '',
    destination: f.destination || '',
    lastSeenAt: f.lastSeenMs ?? Date.now(),
    firstSeenAt: f.firstSeenMs ?? 0,
    confidence: (CONFIDENCE_MAP[f.confidence || ''] || 'MILITARY_CONFIDENCE_LOW') as MilitaryConfidence,
    isInteresting: f.isInteresting ?? false,
    note: f.note || '',
    enrichment: undefined,
  };
}

// Negative cache for the stale Redis read — mirrors the legacy
// /api/military-flights handler's NEG_TTL=30_000ms. When the live fetch fails
// AND the stale key is also empty/unparseable, suppress further Redis reads
// of REDIS_STALE_KEY for STALE_NEG_TTL_MS so we don't hammer Redis once per
// request during sustained relay+seed outages. Per-isolate (Vercel Edge state),
// which is fine — each warm isolate gets its own 30s suppression window.
const STALE_NEG_TTL_MS = 30_000;
let staleNegUntil = 0;

// Test seam — exposed for unit tests that need to drive the suppression
// window without sleeping. Not exported from the module's public API.
export function _resetStaleNegativeCacheForTests(): void {
  staleNegUntil = 0;
}

async function fetchStaleFallback(): Promise<ListMilitaryFlightsResponse['flights'] | null> {
  const now = Date.now();
  if (now < staleNegUntil) return null;
  try {
    const raw = (await getRawJson(REDIS_STALE_KEY)) as StalePayload | null;
    if (!raw || !Array.isArray(raw.flights) || raw.flights.length === 0) {
      staleNegUntil = now + STALE_NEG_TTL_MS;
      return null;
    }
    const flights = raw.flights
      .map(staleToProto)
      .filter((f): f is NonNullable<typeof f> => f != null);
    if (flights.length === 0) {
      staleNegUntil = now + STALE_NEG_TTL_MS;
      return null;
    }
    return flights;
  } catch {
    staleNegUntil = now + STALE_NEG_TTL_MS;
    return null;
  }
}

export async function listMilitaryFlights(
  ctx: ServerContext,
  req: ListMilitaryFlightsRequest,
): Promise<ListMilitaryFlightsResponse> {
  try {
    if (!req.neLat && !req.neLon && !req.swLat && !req.swLon) return emptyResponse();
    const requestBounds = normalizeBounds(req);

    // Quantize bbox to a 1° grid so nearby map views share cache entries.
    // Precise coordinates caused near-zero hit rate since every pan/zoom created a unique key.
    const quantizedBB = [
      quantize(req.swLat, BBOX_GRID_STEP),
      quantize(req.swLon, BBOX_GRID_STEP),
      quantize(req.neLat, BBOX_GRID_STEP),
      quantize(req.neLon, BBOX_GRID_STEP),
    ].join(':');
    // Key by the quantized bbox only. The cached value is the complete
    // expanded-cell snapshot, so page size and cursor must NOT fragment it —
    // every page/cursor for the same cell shares one upstream fetch and one
    // entry, and pagination is applied per-request after retrieval.
    const cacheKey = `${REDIS_CACHE_KEY}:${quantizedBB}:${req.operator || ''}:${req.aircraftType || ''}`;

    const fullResult = await cachedFetchJson<ListMilitaryFlightsResponse>(
      cacheKey,
      REDIS_CACHE_TTL,
      async () => {
        // ADSB.lol's military-only feed is the resilient public source for the
        // map. It avoids coupling Air availability to the persistent relay's
        // ability to reach OpenSky's OAuth host. OpenSky remains the secondary
        // path so existing deployments continue to work if ADSB.lol is down.
        const adsbLolFlights = await fetchAdsbLolMilitaryFlights();
        if (adsbLolFlights) {
          return { flights: adsbLolFlights, clusters: [], pagination: undefined };
        }

        const isSidecar = (process.env.LOCAL_API_MODE || '').includes('sidecar');
        const relayBase = isSidecar ? null : getRelayBaseUrl();
        const baseUrl = isSidecar ? 'https://opensky-network.org/api/states/all' : relayBase ? relayBase + '/opensky' : null;

        if (!baseUrl) return null;

        const fetchBB = {
          lamin: quantize(req.swLat, BBOX_GRID_STEP) - BBOX_GRID_STEP / 2,
          lamax: quantize(req.neLat, BBOX_GRID_STEP) + BBOX_GRID_STEP / 2,
          lomin: quantize(req.swLon, BBOX_GRID_STEP) - BBOX_GRID_STEP / 2,
          lomax: quantize(req.neLon, BBOX_GRID_STEP) + BBOX_GRID_STEP / 2,
        };
        const params = new URLSearchParams();
        params.set('lamin', String(fetchBB.lamin));
        params.set('lamax', String(fetchBB.lamax));
        params.set('lomin', String(fetchBB.lomin));
        params.set('lomax', String(fetchBB.lomax));

        const url = `${baseUrl!}${params.toString() ? '?' + params.toString() : ''}`;
        const resp = await fetch(url, {
          headers: getRelayHeaders(),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });

        if (!resp.ok) return null;

        const data = (await resp.json()) as { states?: Array<[string, string, ...unknown[]]> };
        if (!data.states) return null;

        const flights: ListMilitaryFlightsResponse['flights'] = [];
        for (const state of data.states) {
          const [icao24, callsign, , , , lon, lat, altitude, onGround, velocity, heading] = state as [
            string, string, unknown, unknown, unknown, number | null, number | null, number | null, boolean, number | null, number | null,
          ];
          if (lat == null || lon == null || onGround) continue;
          if (!isMilitaryCallsign(callsign) && !isMilitaryHex(icao24)) continue;

          const aircraftType = detectAircraftType(callsign);
          // Canonicalize hex_code to uppercase — the seed cron
          // (scripts/seed-military-flights.mjs) writes uppercase, and
          // src/services/military-flights.ts getFlightByHex uppercases the
          // lookup input. Preserving OpenSky's lowercase here would break
          // every hex lookup silently.
          const hex = icao24.toUpperCase();

          flights.push({
            id: hex,
            callsign: (callsign || '').trim(),
            hexCode: hex,
            registration: '',
            aircraftType: (AIRCRAFT_TYPE_MAP[aircraftType] || 'MILITARY_AIRCRAFT_TYPE_UNKNOWN') as MilitaryAircraftType,
            aircraftModel: '',
            operator: 'MILITARY_OPERATOR_OTHER',
            operatorCountry: '',
            location: { latitude: lat, longitude: lon },
            altitude: altitude ?? 0,
            heading: heading ?? 0,
            speed: (velocity as number) ?? 0,
            verticalRate: 0,
            onGround: false,
            squawk: '',
            origin: '',
            destination: '',
            lastSeenAt: Date.now(),
            firstSeenAt: 0,
            confidence: 'MILITARY_CONFIDENCE_LOW',
            isInteresting: false,
            note: '',
            enrichment: undefined,
          });
        }

        return flights.length > 0 ? { flights, clusters: [], pagination: undefined } : null;
      },
    );

    if (!fullResult) {
      // Live fetch failed. The legacy /api/military-flights handler cascaded
      // military:flights:v1 → military:flights:stale:v1 before returning empty.
      // The seed cron (scripts/seed-military-flights.mjs) writes both keys
      // every run; stale has a 24h TTL versus 10min live, so it's the right
      // fallback when OpenSky / the relay hiccups.
      const staleFlights = await fetchStaleFallback();
      if (staleFlights && staleFlights.length > 0) {
        return paginateResponse(staleFlights, [], requestBounds, req);
      }
      markNoCacheResponse(ctx.request);
      return emptyResponse();
    }
    return paginateResponse(fullResult.flights, fullResult.clusters, requestBounds, req);
  } catch {
    markNoCacheResponse(ctx.request);
    return emptyResponse();
  }
}
