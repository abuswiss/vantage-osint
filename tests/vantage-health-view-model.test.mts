import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getCoverageSurfaces, parseVantageHealth } from '../src/services/vantage-health';

describe('Vantage coverage view model', () => {
  it('projects current, delayed, and unavailable service states honestly', () => {
    const snapshot = parseVantageHealth({
      status: 'degraded',
      checkedAt: '2026-08-12T10:00:00.000Z',
      services: {
        redis: 'ready',
        news: { status: 'ready', ageSeconds: 75 },
        insights: { status: 'stale', ageSeconds: 3_000 },
        risk: { status: 'ready', ageSeconds: 120 },
        relay: { status: 'degraded', air: 'waiting', ships: 'unavailable' },
      },
    });
    assert.ok(snapshot);
    const surfaces = getCoverageSurfaces(snapshot);
    assert.deepEqual(surfaces.map(({ id, state }) => ({ id, state })), [
      { id: 'reports', state: 'current' },
      { id: 'brief', state: 'delayed' },
      { id: 'risk', state: 'current' },
      { id: 'air', state: 'delayed' },
      { id: 'ships', state: 'unavailable' },
    ]);
    assert.match(surfaces[0]!.detail, /1m ago/);
    assert.match(surfaces[3]!.detail, /has not received current positions/);
  });

  it('fails closed to checking when no validated readiness snapshot exists', () => {
    assert.equal(parseVantageHealth({ status: 'ready' }), null);
    assert.equal(getCoverageSurfaces(null).every((surface) => surface.state === 'checking'), true);
  });
});
