/**
 * Country-brief coverage model: "loaded and quiet" and "never loaded" must be
 * distinguishable, and the timeline lane mapping must follow the domains.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { buildCountryBriefCoverage } from '../src/services/country-signal-coverage.ts';

const ALL_PRESENT = {
  news: true,
  protests: true,
  military: true,
  outages: true,
  earthquakes: true,
  cii: true,
};

describe('buildCountryBriefCoverage', () => {
  it('reports no gaps when every source is loaded', () => {
    const coverage = buildCountryBriefCoverage(ALL_PRESENT);
    assert.equal(coverage.hasGaps, false);
    assert.deepEqual(coverage.unavailableDomains, []);
    assert.deepEqual(coverage.timelineUnavailableLanes, []);
  });

  it('maps missing sources to domains and timeline lanes', () => {
    const coverage = buildCountryBriefCoverage({
      ...ALL_PRESENT,
      protests: false,
      military: false,
    });
    assert.equal(coverage.hasGaps, true);
    assert.deepEqual(coverage.unavailableDomains, ['protests', 'military']);
    assert.deepEqual(coverage.timelineUnavailableLanes.sort(), ['military', 'protest']);
  });

  it('maps CII absence to the conflict lane and quake absence to natural', () => {
    const coverage = buildCountryBriefCoverage({
      ...ALL_PRESENT,
      cii: false,
      earthquakes: false,
    });
    assert.deepEqual(coverage.unavailableDomains, ['earthquakes', 'conflict']);
    assert.deepEqual(coverage.timelineUnavailableLanes.sort(), ['conflict', 'natural']);
  });

  it('treats an empty-but-loaded source as available (quiet, not missing)', () => {
    // Presence flags are computed from cache-slot existence, not item counts —
    // the caller passes true for a loaded-but-empty feed.
    const coverage = buildCountryBriefCoverage({ ...ALL_PRESENT, news: true });
    assert.equal(coverage.unavailableDomains.includes('news'), false);
  });
});
