import { beforeAll, afterEach, describe, expect, it } from 'vitest';

import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { initI18n } from '@/services/i18n';
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

describe('CountryDeepDivePanel missing country facts', () => {
  beforeAll(async () => {
    await initI18n();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('omits zero and blank sentinel values while retaining known facts', () => {
    const panel = new CountryDeepDivePanel();
    panel.show('Ukraine', 'UA', null, emptySignals());
    panel.updateCountryFacts({
      headOfState: 'Volodymyr Zelenskyy',
      headOfStateTitle: '',
      wikipediaSummary: '',
      wikipediaThumbnailUrl: '',
      population: 0,
      capital: '',
      languages: [],
      currencies: [],
      areaSqKm: 0,
      countryName: '',
    });

    const facts = document.querySelector('.cdp-facts-grid');
    expect(facts?.textContent).toContain('Volodymyr Zelenskyy');
    expect(facts?.textContent).not.toMatch(/(?:^|\s)0(?:\s|$)/);
    expect(facts?.textContent).not.toContain('km²');
    expect(facts?.querySelectorAll('.cdp-fact-item')).toHaveLength(1);
  });
});
