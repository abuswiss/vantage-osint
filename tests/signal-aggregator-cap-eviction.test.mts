/**
 * Truth gap: the aggregator's bounded cap (SIGNAL_AGGREGATOR_MAX_SIGNALS)
 * silently dropped a country's signals, making "evicted by capacity"
 * indistinguishable from "genuinely quiet" — consumers rendered zeros either
 * way. wasCountryCapEvicted() must report capacity loss so severity surfaces
 * can say "omitted", never "quiet", for an evicted country.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  SIGNAL_AGGREGATOR_MAX_SIGNALS,
  signalAggregator,
} from '@/services/signal-aggregator';
import type { InternetOutage } from '@/types';

function outage(country: string, index: number, ageMs: number): InternetOutage {
  return {
    id: `${country}-${index}`,
    title: `Outage ${country} ${index}`,
    link: '',
    description: '',
    pubDate: new Date(Date.now() - ageMs),
    country,
    lat: 0,
    lon: 0,
    severity: 'major',
    categories: [],
  };
}

describe('signalAggregator cap eviction tracking', () => {
  beforeEach(() => {
    signalAggregator.clear();
  });

  it('flags a country whose signals were all dropped by the cap', () => {
    const old = Array.from({ length: 100 }, (_, i) => outage('AA', i, 2 * 60 * 60 * 1000));
    const fresh = Array.from({ length: SIGNAL_AGGREGATOR_MAX_SIGNALS }, (_, i) => outage('BB', i, 60 * 60 * 1000));
    signalAggregator.ingestOutages([...old, ...fresh]);

    assert.equal(signalAggregator.getSignalCount(), SIGNAL_AGGREGATOR_MAX_SIGNALS);

    const clusters = signalAggregator.getCountryClusters();
    assert.equal(clusters.some((c) => c.country === 'AA'), false, 'AA signals should have been evicted');
    assert.equal(clusters.some((c) => c.country === 'BB'), true);

    assert.equal(signalAggregator.wasCountryCapEvicted('AA'), true, 'AA absence is capacity loss, not quiet');
    assert.equal(signalAggregator.wasCountryCapEvicted('BB'), false, 'BB is fully represented');
  });

  it('does not flag any country while under the cap', () => {
    signalAggregator.ingestOutages([outage('AA', 0, 60_000), outage('BB', 0, 60_000)]);
    assert.equal(signalAggregator.wasCountryCapEvicted('AA'), false);
    assert.equal(signalAggregator.wasCountryCapEvicted('CC'), false, 'a country with no signals at all is honestly quiet');
  });

  it("expires the flag at the evicted signal's own window boundary, not 24h after eviction", () => {
    const originalNow = Date.now;
    const HOUR = 60 * 60 * 1000;
    const base = Date.parse('2026-08-01T12:00:00Z');
    try {
      Date.now = () => base;
      // AA's signal is already 20h into its 24h window when the cap evicts
      // it, so the eviction can only vouch for a coverage gap for 4 more
      // hours — after that the signal would have aged out anyway.
      const old = [outage('AA', 0, 20 * HOUR)];
      const fresh = Array.from({ length: SIGNAL_AGGREGATOR_MAX_SIGNALS }, (_, i) => outage('BB', i, HOUR));
      signalAggregator.ingestOutages([...old, ...fresh]);
      assert.equal(signalAggregator.wasCountryCapEvicted('AA'), true);

      Date.now = () => base + 4 * HOUR - 1;
      assert.equal(signalAggregator.wasCountryCapEvicted('AA'), true, 'gap is still real just inside the original window');

      Date.now = () => base + 4 * HOUR;
      assert.equal(
        signalAggregator.wasCountryCapEvicted('AA'),
        false,
        'flag must clear at original timestamp + window, not 24h after the eviction event',
      );
    } finally {
      Date.now = originalNow;
      signalAggregator.clear();
    }
  });

  it('repeated evictions retain the latest relevant expiry per country', () => {
    const originalNow = Date.now;
    const HOUR = 60 * 60 * 1000;
    const base = Date.parse('2026-08-01T12:00:00Z');
    try {
      Date.now = () => base;
      const fresh = () => Array.from({ length: SIGNAL_AGGREGATOR_MAX_SIGNALS }, (_, i) => outage('BB', i, HOUR));
      // First eviction: 20h-old signal → expiry base+4h.
      signalAggregator.ingestOutages([outage('AA', 0, 20 * HOUR), ...fresh()]);
      // Second eviction: 10h-old signal → expiry base+14h must win.
      signalAggregator.ingestOutages([outage('AA', 1, 10 * HOUR), ...fresh()]);

      Date.now = () => base + 5 * HOUR;
      assert.equal(signalAggregator.wasCountryCapEvicted('AA'), true, 'later eviction extends validity past the first expiry');

      Date.now = () => base + 14 * HOUR;
      assert.equal(signalAggregator.wasCountryCapEvicted('AA'), false, 'flag clears at the latest evicted signal boundary');
    } finally {
      Date.now = originalNow;
      signalAggregator.clear();
    }
  });

  it('an eviction of an older signal never shrinks a later expiry from the same snapshot', () => {
    const originalNow = Date.now;
    const HOUR = 60 * 60 * 1000;
    const base = Date.parse('2026-08-01T12:00:00Z');
    try {
      Date.now = () => base;
      const fresh = Array.from({ length: SIGNAL_AGGREGATOR_MAX_SIGNALS }, (_, i) => outage('BB', i, HOUR));
      // One snapshot loses both a newer AA signal (expiry base+14h) and an
      // older one (expiry base+4h) to the cap — the max expiry must win.
      // (Across SEPARATE snapshots of the same type, replacement retires the
      // earlier evidence instead: see the provenance test below.)
      signalAggregator.ingestOutages([outage('AA', 0, 10 * HOUR), outage('AA', 1, 20 * HOUR), ...fresh]);

      Date.now = () => base + 5 * HOUR;
      assert.equal(signalAggregator.wasCountryCapEvicted('AA'), true, 'older-signal eviction must not shorten validity');

      Date.now = () => base + 14 * HOUR;
      assert.equal(signalAggregator.wasCountryCapEvicted('AA'), false, 'flag clears at the newest evicted signal boundary');
    } finally {
      Date.now = originalNow;
      signalAggregator.clear();
    }
  });

  it('re-ingesting a source type retires only that type\'s eviction evidence', () => {
    const originalNow = Date.now;
    const HOUR = 60 * 60 * 1000;
    const base = Date.parse('2026-08-01T12:00:00Z');
    const radiation = (country: string, ageMs: number) => ({
      id: `rad-${country}`,
      source: 'EPA RadNet' as const,
      contributingSources: ['EPA RadNet' as const],
      location: 'Station',
      country,
      lat: 0,
      lon: 0,
      value: 120,
      unit: 'nSv/h',
      observedAt: new Date(base - ageMs),
      freshness: 'live' as const,
      baselineValue: 80,
      delta: 40,
      zScore: 4,
      severity: 'elevated' as const,
      confidence: 'high' as const,
      corroborated: true,
      conflictingSources: false,
      convertedFromCpm: false,
      sourceCount: 1,
    });
    try {
      Date.now = () => base;
      // DD's radiation anomaly (3h old) and AA's outage (2h old) are both
      // evicted when the fresh BB outages overflow the cap.
      signalAggregator.ingestRadiationObservations([radiation('DD', 3 * HOUR)]);
      const fresh = Array.from({ length: SIGNAL_AGGREGATOR_MAX_SIGNALS }, (_, i) => outage('BB', i, HOUR));
      signalAggregator.ingestOutages([outage('AA', 0, 2 * HOUR), ...fresh]);
      assert.equal(signalAggregator.wasCountryCapEvicted('AA'), true);
      assert.equal(signalAggregator.wasCountryCapEvicted('DD'), true);

      // A subsequent under-cap outage snapshot is a complete replacement:
      // AA's outage eviction no longer describes a coverage gap, so AA reads
      // complete/quiet again — while DD's radiation evidence, produced by a
      // different signal type, keeps vouching for its own gap.
      signalAggregator.ingestOutages([]);
      assert.equal(signalAggregator.wasCountryCapEvicted('AA'), false, 'replaced-type evidence must retire with the snapshot');
      assert.equal(signalAggregator.wasCountryCapEvicted('DD'), true, 'unrelated-type evidence must survive the outage re-ingest');
    } finally {
      Date.now = originalNow;
      signalAggregator.clear();
    }
  });

  it('clear() resets eviction flags', () => {
    const old = Array.from({ length: 10 }, (_, i) => outage('AA', i, 2 * 60 * 60 * 1000));
    const fresh = Array.from({ length: SIGNAL_AGGREGATOR_MAX_SIGNALS }, (_, i) => outage('BB', i, 60 * 60 * 1000));
    signalAggregator.ingestOutages([...old, ...fresh]);
    assert.equal(signalAggregator.wasCountryCapEvicted('AA'), true);

    signalAggregator.clear();
    assert.equal(signalAggregator.wasCountryCapEvicted('AA'), false);
  });
});
