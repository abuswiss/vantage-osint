/**
 * Regression: locally-generated fallback briefs (country-intel.ts passes
 * `fallback: true`) were labelled "✨ Fresh" because updateBrief only branched
 * on `cached`. Grounded fallback, cached, and fresh are three distinct states
 * and each must be labelled honestly, with a title explaining the state.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { CountryBriefPage } from '@/components/CountryBriefPage';
import { initI18n, t } from '@/services/i18n';
import type { CountryBriefSignals } from '@/types';

function emptySignals(): CountryBriefSignals {
  return {
    criticalNews: 0, protests: 0, militaryFlights: 0, militaryVessels: 0,
    militaryFlightsInCountry: 0, militaryVesselsInCountry: 0, outages: 0,
    aisDisruptions: 0, satelliteFires: 0, radiationAnomalies: 0,
    temporalAnomalies: 0, cyberThreats: 0, earthquakes: 0,
    displacementOutflow: 0, climateStress: 0, conflictEvents: 0,
    activeStrikes: 0, orefSirens: 0, orefHistory24h: 0,
    aviationDisruptions: 0, travelAdvisories: 0, travelAdvisoryMaxLevel: null,
    gpsJammingHexes: 0, isTier1: true, thermalEscalations: 0,
    sanctionsDesignations: 0, sanctionsNewDesignations: 0,
  };
}

function openBrief(page: CountryBriefPage): void {
  page.show('Ukraine', 'UA', null, emptySignals());
}

describe('CountryBriefPage brief status labelling', () => {
  beforeAll(async () => {
    await initI18n();
    // The full dictionary merges asynchronously after init; wait until a
    // non-shell key resolves so labels render as text, not raw keys.
    for (let i = 0; i < 200 && t('modals.countryBrief.fresh') === 'modals.countryBrief.fresh'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

  function renderBrief(data: Record<string, unknown>): HTMLElement {
    const page = new CountryBriefPage();
    openBrief(page);
    page.updateBrief({ brief: 'Situation summary.', country: 'Ukraine', code: 'UA', ...data } as never);
    const footer = document.querySelector('.cb-brief-footer');
    if (!(footer instanceof HTMLElement)) throw new Error('brief footer not rendered');
    return footer;
  }

  it('labels grounded fallback briefs as grounded, never Fresh', () => {
    const footer = renderBrief({ fallback: true });
    expect(footer.textContent).toContain('Grounded summary');
    expect(footer.textContent).not.toContain('Fresh');
    const chip = footer.querySelector('.intel-cached');
    expect(chip?.getAttribute('title')).toMatch(/unavailable/i);
    document.body.innerHTML = '';
  });

  it('labels cached briefs as cached with an explanation', () => {
    const footer = renderBrief({ cached: true });
    expect(footer.textContent).toContain('Cached');
    expect(footer.querySelector('.intel-cached')?.getAttribute('title')).toBeTruthy();
    document.body.innerHTML = '';
  });

  it('labels live briefs as fresh', () => {
    const footer = renderBrief({});
    expect(footer.textContent).toContain('Fresh');
    document.body.innerHTML = '';
  });
});
