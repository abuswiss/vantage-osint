import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  adsbLolAircraftToOpenSkyState,
  fetchAirFallback,
  normalizeAirFallbackBbox,
} = await import('./_air-fallback.js');

describe('live air provider fallback', () => {
  it('validates and normalizes an optional bbox', () => {
    assert.deepEqual(normalizeAirFallbackBbox('https://example.test/api/opensky'), { bbox: null });
    assert.deepEqual(
      normalizeAirFallbackBbox('https://example.test/api/opensky?lamin=45&lomin=5&lamax=55&lomax=15'),
      { bbox: { lamin: 45, lomin: 5, lamax: 55, lomax: 15 } },
    );
    assert.deepEqual(
      normalizeAirFallbackBbox('https://example.test/api/opensky?lamin=45&lomin=5'),
      { error: 'Provide all bbox params: lamin,lomin,lamax,lomax' },
    );
  });

  it('maps provider units to the OpenSky-compatible state shape', () => {
    const state = adsbLolAircraftToOpenSkyState({
      hex: '~ABC123',
      flight: ' RCH101 ',
      lat: 50,
      lon: 10,
      alt_baro: 10_000,
      gs: 194.384,
      track: 90,
      baro_rate: 196.85,
      squawk: '1234',
      seen: 2,
    }, 1_000);
    assert.equal(state[0], 'abc123');
    assert.equal(state[1], 'RCH101');
    assert.equal(state[4], 998);
    assert.equal(state[7], 3_048);
    assert.ok(Math.abs(state[9] - 100) < 1e-9);
    assert.ok(Math.abs(state[11] - 1) < 1e-9);
  });

  it('serves only current military positions inside the requested bbox', async () => {
    const response = await fetchAirFallback(
      new Request('https://example.test/api/opensky?lamin=45&lomin=5&lamax=55&lomax=15'),
      { 'Access-Control-Allow-Origin': '*' },
      {
        now: () => 1_000_000,
        fetchImpl: async () => new Response(JSON.stringify({
          ac: [
            { hex: 'abc123', flight: 'RCH101', lat: 50, lon: 10, alt_baro: 10_000 },
            { hex: 'def456', flight: 'NAVY1', lat: 30, lon: 10, alt_baro: 8_000 },
            { hex: '', lat: 50, lon: 10 },
          ],
        }), { status: 200 }),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-data-source'), 'adsb-lol-military');
    const payload = await response.json();
    assert.equal(payload.time, 1_000);
    assert.equal(payload.states.length, 1);
    assert.equal(payload.states[0][0], 'abc123');
  });

  it('does not disguise an upstream failure as healthy empty data', async () => {
    const response = await fetchAirFallback(
      new Request('https://example.test/api/opensky'),
      {},
      { fetchImpl: async () => new Response('', { status: 503 }) },
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: 'Live air fallback request failed',
      upstreamStatus: 503,
      states: [],
    });
  });
});
