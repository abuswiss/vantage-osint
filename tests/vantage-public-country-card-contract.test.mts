import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCountryDeepDivePanelHarness } from './helpers/country-deep-dive-panel-harness.mjs';

const EMPTY_SIGNALS = {
  criticalNews: 0,
  protests: 0,
  militaryFlights: 0,
  militaryVessels: 0,
  militaryFlightsInCountry: 0,
  militaryVesselsInCountry: 0,
  outages: 0,
  aisDisruptions: 0,
  satelliteFires: 0,
  radiationAnomalies: 0,
  temporalAnomalies: 0,
  cyberThreats: 0,
  earthquakes: 0,
  displacementOutflow: 0,
  climateStress: 0,
  conflictEvents: 0,
  activeStrikes: 0,
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

async function waitForResilienceWidget(
  harness: Awaited<ReturnType<typeof createCountryDeepDivePanelHarness>>,
): Promise<void> {
  for (let attempt = 0; attempt < 50 && harness.getWidgets().length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(harness.getWidgets().length, 1, 'resilience widget should settle before harness cleanup');
}

function click(element: Element): void {
  element.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
}

describe('Vantage public country-card boundary', () => {
  it('renders every country-card module without a sign-in, upgrade, or lock surface', async () => {
    const harness = await createCountryDeepDivePanelHarness({ premiumAccess: true });
    try {
      const panel = harness.createPanel();
      panel.show('Ukraine', 'UA', null, EMPTY_SIGNALS);
      await waitForResilienceWidget(harness);

      const root = harness.getPanelRoot();
      assert.ok(root, 'country-card root should render');
      assert.equal(root.querySelectorAll('.cdp-pro-locked').length, 0);
      assert.doesNotMatch(root.textContent ?? '', /sign[ -]?in|upgrade to pro|available with pro/i);

      const evidence = root.querySelector('.cdp-evidence-export-btn');
      assert.ok(evidence instanceof globalThis.HTMLButtonElement);
      click(evidence);
      assert.deepEqual(harness.getGateHits(), [], 'public evidence action must not invoke a gate');
      assert.deepEqual(harness.getToasts(), [], 'public evidence action must not show upgrade copy');
      assert.equal(harness.getEvidenceExports().length, 1, 'public evidence action should remain functional');
    } finally {
      harness.cleanup();
    }
  });

  it('keeps the canonical anonymous WorldMonitor country-card gates intact', async () => {
    const harness = await createCountryDeepDivePanelHarness({ premiumAccess: false });
    try {
      const panel = harness.createPanel();
      panel.show('Ukraine', 'UA', null, EMPTY_SIGNALS);
      await waitForResilienceWidget(harness);

      const root = harness.getPanelRoot();
      assert.ok(root, 'country-card root should render');
      assert.ok(root.querySelectorAll('.cdp-pro-locked').length > 0);
      assert.match(root.textContent ?? '', /upgrade to pro/i);

      const evidence = root.querySelector('.cdp-evidence-export-btn');
      assert.ok(evidence instanceof globalThis.HTMLButtonElement);
      click(evidence);
      assert.deepEqual(harness.getGateHits(), ['evidence-export']);
      assert.equal(harness.getEvidenceExports().length, 0);
      assert.match(harness.getToasts().join(' '), /available on pro/i);
    } finally {
      harness.cleanup();
    }
  });
});
