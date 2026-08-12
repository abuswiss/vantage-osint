import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResilienceScoreResponse } from '@/services/resilience';

const getResilienceScore = vi.hoisted(() => vi.fn(async (): Promise<ResilienceScoreResponse> => ({
  countryCode: 'UA',
  overallScore: 61,
  level: 'moderate',
  domains: [],
  trend: 'stable',
  change30d: 0,
  lowConfidence: false,
  imputationShare: 0,
  baselineScore: 70,
  stressScore: 55,
  stressFactor: 0.2,
  dataVersion: '2026-08-09',
  pillars: [],
  schemaVersion: '2.0',
  headlineEligible: true,
})));

vi.mock('@/config/product-policy', () => ({
  VANTAGE_PUBLIC_MODE: true,
  VANTAGE_RELAY_ENABLED: true,
  isPublicVantageCapability: () => true,
}));

vi.mock('@/services/auth-state', () => ({
  getAuthState: () => ({ user: null, isPending: true }),
  subscribeAuthState: (listener: (state: { user: null; isPending: boolean }) => void) => {
    listener({ user: null, isPending: true });
    return () => {};
  },
}));

vi.mock('@/services/runtime-config', () => ({
  getSecretState: () => ({ present: false, valid: false, source: 'missing' }),
}));

vi.mock('@/services/widget-store', () => ({ isProUser: () => false }));
vi.mock('@/services/entitlements', () => ({ getEntitlementState: () => null }));
vi.mock('@/services/billing', () => ({
  getSubscription: () => null,
  openBillingPortal: vi.fn(),
  prereserveBillingPortalTab: () => null,
}));
vi.mock('@/services/billing-state', () => ({
  deriveBillingUxState: () => 'free',
  getBillingGateOverride: () => null,
  getReactivationHref: () => '/pro',
}));
vi.mock('@/services/resilience', () => ({ getResilienceScore }));

const { PanelGateReason, getPanelGateReason } = await import('@/services/panel-gating');
const { ResilienceWidget } = await import('@/components/ResilienceWidget');

afterEach(() => {
  getResilienceScore.mockClear();
  document.body.replaceChildren();
});

describe('public Vantage resilience access', () => {
  it('maps an anonymous pending session to an unlocked panel', () => {
    expect(getPanelGateReason({ user: null, isPending: true }, true)).toBe(PanelGateReason.NONE);
  });

  it('loads and renders the real score without access copy, blur, or CTA', async () => {
    const widget = new ResilienceWidget('UA');
    document.body.append(widget.getElement());

    await vi.waitFor(() => {
      expect(widget.getElement().querySelector('.resilience-widget__overall-score')?.textContent).toBe('61');
    });

    const text = widget.getElement().textContent ?? '';
    expect(getResilienceScore).toHaveBeenCalledWith('UA');
    expect(text).not.toMatch(/checking access|sign in|upgrade|premium/i);
    expect(widget.getElement().querySelector('.resilience-widget__preview')).toBeNull();
    expect(widget.getElement().querySelector('.resilience-widget__cta')).toBeNull();

    widget.destroy();
  });

  it('keeps sparse scores provisional, missing domains unavailable, and dense dimensions collapsed', async () => {
    getResilienceScore.mockResolvedValueOnce({
      countryCode: 'UA',
      overallScore: 50,
      level: 'medium',
      domains: [
        {
          id: 'economic',
          score: 0,
          weight: 1,
          dimensions: [{
            id: 'macroFiscal',
            score: 0,
            coverage: 0,
            observedWeight: 0,
            imputedWeight: 0,
            imputationClass: '',
          }],
        },
        {
          id: 'recovery',
          score: 0,
          weight: 1,
          dimensions: [{
            id: 'sovereignFiscalBuffer',
            score: 0,
            coverage: 1,
            observedWeight: 1,
            imputedWeight: 0,
            imputationClass: '',
          }],
        },
      ],
      trend: 'stable',
      change30d: 0,
      lowConfidence: true,
      imputationShare: 0.5,
      baselineScore: 50,
      stressScore: 50,
      stressFactor: 0.5,
      dataVersion: '2026-08-09',
      pillars: [],
      schemaVersion: '2.0',
      headlineEligible: false,
    });

    const widget = new ResilienceWidget('UA');
    document.body.append(widget.getElement());

    await vi.waitFor(() => {
      expect(widget.getElement().querySelector('.resilience-widget__coverage-notice')).not.toBeNull();
    });

    const notice = widget.getElement().querySelector('.resilience-widget__coverage-notice')?.textContent ?? '';
    expect(notice).toContain('Insufficient coverage');
    expect(notice).toContain('Provisional');
    expect(notice).toContain('Not ranked');
    expect(
      [...widget.getElement().querySelectorAll('.resilience-widget__domain-score')]
        .map((element) => element.textContent),
    ).toEqual(['n/a', '0']);
    expect(widget.getElement().querySelector('.resilience-widget__baseline-stress')).toBeNull();

    const disclosure = widget.getElement().querySelector('details.resilience-widget__dimension-disclosure');
    expect(disclosure).not.toBeNull();
    expect(disclosure?.hasAttribute('open')).toBe(false);

    widget.destroy();
  });
});
