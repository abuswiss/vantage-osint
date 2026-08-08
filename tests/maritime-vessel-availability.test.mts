import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildPortWatchTrafficSnapshot,
  isUsableLiveVesselSnapshot,
} from '../server/worldmonitor/maritime/v1/get-vessel-snapshot';

describe('maritime availability contract', () => {
  it('rejects open-but-silent and disconnected AIS snapshots', () => {
    const base = {
      snapshotAt: Date.now(),
      densityZones: [],
      disruptions: [],
      sequence: 1,
      candidateReports: [],
      tankerReports: [],
    };
    assert.equal(isUsableLiveVesselSnapshot({
      ...base,
      status: { connected: true, vessels: 0, messages: 0 },
    }), false);
    assert.equal(isUsableLiveVesselSnapshot({
      ...base,
      status: { connected: false, vessels: 10, messages: 100 },
    }), false);
    assert.equal(isUsableLiveVesselSnapshot({
      ...base,
      status: { connected: true, vessels: 10, messages: 100 },
    }), true);
  });

  it('builds an explicitly aggregate PortWatch fallback only from covered rows', () => {
    const snapshot = buildPortWatchTrafficSnapshot({
      fetchedAt: 1_786_000_000_000,
      summaries: {
        suez: { todayTotal: 42, wowChangePct: -8, dataAvailable: true },
        panama: { todayTotal: 10, wowChangePct: 3, dataAvailable: false },
      },
    });

    assert.ok(snapshot);
    assert.equal(snapshot.snapshotAt, 1_786_000_000_000);
    assert.deepEqual(snapshot.status, { connected: false, vessels: 0, messages: 0 });
    assert.equal(snapshot.densityZones.length, 1);
    assert.equal(snapshot.densityZones[0]?.id, 'portwatch-suez');
    assert.equal(snapshot.densityZones[0]?.shipsPerDay, 42);
    assert.equal(snapshot.densityZones[0]?.deltaPct, -8);
    assert.match(snapshot.densityZones[0]?.note ?? '', /aggregate|PortWatch|daily transit/i);
  });

  it('returns unavailable when no aggregate row has proven coverage', () => {
    assert.equal(buildPortWatchTrafficSnapshot({
      summaries: { suez: { todayTotal: 0, dataAvailable: false } },
    }), undefined);
  });
});
