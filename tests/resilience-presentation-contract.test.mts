import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getResilienceDomainDisplay,
  getResiliencePresentationState,
} from '../src/components/resilience-widget-utils.ts';
import type { ResilienceScoreResponse } from '../src/services/resilience.ts';

type Domain = ResilienceScoreResponse['domains'][number];

function domainWithDimension(
  score: number,
  dimension: Domain['dimensions'][number],
): Domain {
  return {
    id: 'economic',
    score,
    weight: 1,
    dimensions: [dimension],
  };
}

function responseWithDomains(
  domains: Domain[],
  overrides: Partial<ResilienceScoreResponse> = {},
): ResilienceScoreResponse {
  return {
    countryCode: 'UA',
    overallScore: 50,
    level: 'medium',
    domains,
    trend: 'stable',
    change30d: 0,
    lowConfidence: false,
    imputationShare: 0,
    baselineScore: 50,
    stressScore: 50,
    stressFactor: 0.5,
    dataVersion: '2026-08-09',
    pillars: [],
    schemaVersion: '2.0',
    headlineEligible: true,
    ...overrides,
  };
}

describe('resilience presentation contract', () => {
  it('renders a zero-valued domain as unavailable when the requested country has no covered input', () => {
    const domain = domainWithDimension(0, {
      id: 'macroFiscal',
      score: 0,
      coverage: 0,
      observedWeight: 0,
      imputedWeight: 0,
      imputationClass: '',
    });

    assert.deepEqual(getResilienceDomainDisplay(domain), {
      hasScore: false,
      scoreForBar: 0,
      scoreLabel: 'n/a',
      coveragePct: 0,
    });
  });

  it('preserves an actual observed zero instead of converting it to unavailable', () => {
    const domain = domainWithDimension(0, {
      id: 'sovereignFiscalBuffer',
      score: 0,
      coverage: 1,
      observedWeight: 1,
      imputedWeight: 0,
      imputationClass: '',
    });

    assert.deepEqual(getResilienceDomainDisplay(domain), {
      hasScore: true,
      scoreForBar: 0,
      scoreLabel: '0',
      coveragePct: 100,
    });
  });

  it('marks an all-imputed numeric score provisional and not ranked', () => {
    const data = responseWithDomains([
      domainWithDimension(50, {
        id: 'macroFiscal',
        score: 50,
        coverage: 0.3,
        observedWeight: 0,
        imputedWeight: 1,
        imputationClass: 'unmonitored',
      }),
    ], {
      overallScore: 50,
      lowConfidence: true,
      imputationShare: 1,
      headlineEligible: false,
    });

    assert.deepEqual(getResiliencePresentationState(data), {
      provisional: true,
      notRanked: true,
      allImputed: true,
      headline: 'Insufficient coverage',
    });
  });

  it('does not let retired or structurally not-applicable dimensions manufacture country coverage', () => {
    const data = responseWithDomains([
      {
        id: 'recovery',
        score: 0,
        weight: 1,
        dimensions: [
          {
            id: 'reserveAdequacy',
            score: 50,
            coverage: 0,
            observedWeight: 0,
            imputedWeight: 0,
            imputationClass: '',
          },
          {
            id: 'fuelStockDays',
            score: 50,
            coverage: 0,
            observedWeight: 0,
            imputedWeight: 0,
            imputationClass: '',
          },
          {
            id: 'sovereignFiscalBuffer',
            score: 0,
            coverage: 0,
            observedWeight: 0,
            imputedWeight: 0,
            imputationClass: 'not-applicable',
          },
        ],
      },
    ], {
      overallScore: 0,
      level: 'unknown',
      headlineEligible: false,
    });

    assert.deepEqual(getResiliencePresentationState(data), {
      provisional: false,
      notRanked: true,
      allImputed: false,
      headline: 'Insufficient coverage',
    });
  });
});
