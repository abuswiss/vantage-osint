/**
 * Country brief semantic consistency (Phase 2 trust repair).
 *
 * Regressions pinned here:
 *  1. Severity totals were seeded from unwindowed chip counts and then
 *     overwritten by 24h aggregator counts — the visible flip read as a
 *     contradiction. Totals now render only from updateSignalDetails().
 *  2. Aggregator-unavailable rendered as "0 critical / 0 high" — it must be
 *     an explicit unavailable state (updateSignalDetails(null)).
 *  3. Coverage gaps (caches never loaded) rendered exactly like observed
 *     quiet — updateSignalCoverage() now surfaces them.
 *  4. updateScore() ignored its signals argument, so chips froze at
 *     open-time values while the CII header refreshed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createCountryDeepDivePanelHarness } from './helpers/country-deep-dive-panel-harness.mjs';

// show() schedules async section loads (widgets, facts) that would otherwise
// touch the harness DOM after cleanup() restores the real globals.
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

const BASE_SIGNALS = {
  criticalNews: 3,
  protests: 2,
  militaryFlights: 4,
  militaryVessels: 1,
  militaryFlightsInCountry: 1,
  militaryVesselsInCountry: 0,
  outages: 1,
  aisDisruptions: 0,
  satelliteFires: 0,
  radiationAnomalies: 0,
  temporalAnomalies: 0,
  cyberThreats: 0,
  earthquakes: 0,
  displacementOutflow: 0,
  climateStress: 0,
  conflictEvents: 5,
  activeStrikes: 2,
  orefSirens: 0,
  orefHistory24h: 0,
  aviationDisruptions: 0,
  travelAdvisories: 0,
  travelAdvisoryMaxLevel: null,
  gpsJammingHexes: 0,
  isTier1: true,
  thermalEscalations: 0,
  sanctionsDesignations: 0,
  sanctionsNewDesignations: 0,
};

test('severity totals are not seeded from chip counts at open', async () => {
  const harness = await createCountryDeepDivePanelHarness();
  try {
    const panel = harness.createPanel();
    panel.show('Ukraine', 'UA', null, BASE_SIGNALS);

    const root = harness.getPanelRoot();
    const breakdown = root.querySelector('.cdp-signal-breakdown');
    assert.ok(breakdown, 'breakdown container renders');
    assert.equal(
      breakdown.querySelectorAll('.cdp-metric').length,
      0,
      'no severity numbers may render before the aggregator answers',
    );
  } finally {
    await settle();
    harness.cleanup();
  }
});

test('aggregator-unavailable renders an explicit state, not zeros', async () => {
  const harness = await createCountryDeepDivePanelHarness();
  try {
    const panel = harness.createPanel();
    panel.show('Ukraine', 'UA', null, BASE_SIGNALS);
    panel.updateSignalDetails(null);

    const breakdown = harness.getPanelRoot().querySelector('.cdp-signal-breakdown');
    assert.equal(breakdown.querySelectorAll('.cdp-metric').length, 0);
    assert.ok(
      breakdown.textContent.length > 0,
      'unavailable state must carry explanatory text',
    );
    assert.ok(!/\b0\b/.test(breakdown.textContent), 'must not print zeros');
  } finally {
    await settle();
    harness.cleanup();
  }
});

test('real severity totals render with their 24h window declared', async () => {
  const harness = await createCountryDeepDivePanelHarness();
  try {
    const panel = harness.createPanel();
    panel.show('Ukraine', 'UA', null, BASE_SIGNALS);
    panel.updateSignalDetails({ critical: 2, high: 4, medium: 1, low: 0, recentHigh: [] });

    const breakdown = harness.getPanelRoot().querySelector('.cdp-signal-breakdown');
    assert.equal(breakdown.querySelectorAll('.cdp-metric').length, 4);
    assert.ok(
      breakdown.querySelector('.cdp-signal-window'),
      'severity totals must declare their aggregation window',
    );
  } finally {
    await settle();
    harness.cleanup();
  }
});

test('coverage gaps surface a note; full coverage hides it', async () => {
  const harness = await createCountryDeepDivePanelHarness();
  try {
    const panel = harness.createPanel();
    panel.show('Ukraine', 'UA', null, BASE_SIGNALS);

    const note = () => harness.getPanelRoot().querySelector('.cdp-signal-coverage');
    assert.ok(note(), 'coverage note container renders');
    assert.equal(note().hidden, true, 'hidden until gaps are reported');

    panel.updateSignalCoverage({
      unavailableDomains: ['protests', 'military'],
      timelineUnavailableLanes: ['protest', 'military'],
      hasGaps: true,
    });
    assert.equal(note().hidden, false);
    assert.ok(note().textContent.length > 0);

    panel.updateSignalCoverage({ unavailableDomains: [], timelineUnavailableLanes: [], hasGaps: false });
    assert.equal(note().hidden, true);
  } finally {
    await settle();
    harness.cleanup();
  }
});

test('updateScore refreshes the signal chips alongside the header', async () => {
  const harness = await createCountryDeepDivePanelHarness();
  try {
    const panel = harness.createPanel();
    panel.show('Ukraine', 'UA', null, BASE_SIGNALS);

    // The harness DOM's selector engine doesn't do descendant combinators;
    // count the chip container's children directly.
    const chipCount = () =>
      harness.getPanelRoot().querySelector('.cdp-signal-chips').children.length;
    const before = chipCount();
    assert.ok(before > 0, 'chips render at open');

    panel.updateScore(null, { ...BASE_SIGNALS, protests: 0, criticalNews: 0, conflictEvents: 0 });
    assert.ok(
      chipCount() < before,
      `chips must re-render from the refreshed signals (before=${before}, after=${chipCount()})`,
    );
  } finally {
    await settle();
    harness.cleanup();
  }
});
