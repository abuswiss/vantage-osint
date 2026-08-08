import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapAdsbLolMilitaryAircraft } from '../server/worldmonitor/military/v1/list-military-flights';

describe('ADSB.lol military fallback', () => {
  it('maps canonical units, preserves useful provenance, and deduplicates hex ids', () => {
    const now = 1_786_000_000_000;
    const flights = mapAdsbLolMilitaryAircraft([
      {
        hex: 'ae1234',
        flight: 'RCH123 ',
        r: '12-3456',
        t: 'C17',
        lat: 37.2,
        lon: -115.8,
        alt_baro: 31_000,
        gs: 440,
        track: 91,
        baro_rate: -640,
        squawk: '1234',
        seen: 2.5,
      },
      { hex: 'AE1234', lat: 1, lon: 1, alt_baro: 10_000 },
    ], now);

    assert.equal(flights.length, 1);
    assert.equal(flights[0]?.id, 'adsblol-AE1234');
    assert.equal(flights[0]?.hexCode, 'AE1234');
    assert.equal(flights[0]?.aircraftType, 'MILITARY_AIRCRAFT_TYPE_TRANSPORT');
    assert.equal(flights[0]?.altitude, 31_000);
    assert.equal(flights[0]?.speed, 440);
    assert.equal(flights[0]?.verticalRate, -640);
    assert.equal(flights[0]?.lastSeenAt, now - 2_500);
    assert.equal(flights[0]?.note, 'ADSB.lol military feed');
  });

  it('rejects grounded, malformed, and out-of-domain positions', () => {
    const flights = mapAdsbLolMilitaryAircraft([
      { hex: 'a1', lat: 1, lon: 1, alt_baro: 'ground' },
      { hex: 'a2', lat: 91, lon: 1, alt_baro: 1_000 },
      { hex: '', lat: 1, lon: 1, alt_baro: 1_000 },
      { hex: 'a3', lat: Number.NaN, lon: 1, alt_baro: 1_000 },
    ]);
    assert.deepEqual(flights, []);
  });
});
