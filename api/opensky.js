import { createRelayHandler } from './_relay.js';
import { fetchAirFallback } from './_air-fallback.js';

export const config = { runtime: 'edge' };

export default createRelayHandler({
  relayPath: '/opensky',
  // Render's OpenSky OAuth route can hang on blocked cloud egress. Give its
  // positive cache a short hit window, then switch to the provider-independent
  // military feed that also backs the canonical Air RPC.
  timeout: 4500,
  onlyOk: true,
  shouldFallback: (response) => [
    'NEG',
    'RATE-LIMITED',
    'DEDUP-NEG',
    'DEDUP-EMPTY',
  ].includes((response.headers.get('x-cache') || '').toUpperCase()),
  fallback: fetchAirFallback,
  cacheHeaders: () => ({
    'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=60, stale-if-error=300',
  }),
  extraHeaders: (response) => {
    const xCache = response.headers.get('x-cache');
    return xCache ? { 'X-Cache': xCache } : {};
  },
});
