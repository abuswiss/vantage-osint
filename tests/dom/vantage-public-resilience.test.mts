import { afterEach, describe, expect, it, vi } from 'vitest';

const getResilienceScore = vi.hoisted(() => vi.fn(async () => ({
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
});
