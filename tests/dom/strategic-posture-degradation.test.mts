/**
 * Regression: Strategic Posture could sit in "Scanning Theaters / connecting"
 * forever when the posture fetch hung — a pending promise never reaches catch,
 * so nothing ended the loading state. fetchAndRender now races each leg
 * against a deadline and degrades to last-known-good (with the stale warning)
 * or an honest "Tracking unavailable" state, while normal resolutions still
 * render live data.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchCachedTheaterPosture = vi.hoisted(() => vi.fn());
const getCachedPosture = vi.hoisted(() => vi.fn());

vi.mock('@/services/cached-theater-posture', () => ({
  fetchCachedTheaterPosture,
  getCachedPosture,
}));
vi.mock('@/services/military-vessels-lazy', () => ({
  getMilitaryVesselsModule: vi.fn(async () => ({
    fetchMilitaryVessels: async () => ({ vessels: [] }),
  })),
  isVesselRuntimeStoppedError: () => false,
}));
vi.mock('@/services/maritime', () => ({
  getAisStatus: () => ({ connected: false, vessels: 0, messages: 0, availability: 'unavailable', zones: 0 }),
}));

import { StrategicPosturePanel } from '@/components/StrategicPosturePanel';
import { initI18n } from '@/services/i18n';

function posture(overrides: Record<string, unknown> = {}) {
  return {
    theaterId: 'baltic-theater',
    theaterName: 'Baltic Theater',
    shortName: 'BALTIC',
    postureLevel: 'normal',
    trend: 'stable',
    changePercent: 0,
    totalAircraft: 4,
    fighters: 0,
    tankers: 0,
    awacs: 0,
    reconnaissance: 0,
    transport: 0,
    bombers: 0,
    drones: 0,
    carriers: 0,
    destroyers: 0,
    frigates: 0,
    submarines: 0,
    patrol: 0,
    auxiliaryVessels: 0,
    totalVessels: 0,
    strikeCapable: false,
    centerLat: 58,
    centerLon: 20,
    byOperator: {},
    ...overrides,
  };
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('StrategicPosturePanel bounded degradation', () => {
  let panel: StrategicPosturePanel | null = null;

  beforeAll(async () => {
    await initI18n();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    getCachedPosture.mockReturnValue(null);
  });

  afterEach(() => {
    panel?.destroy();
    panel = null;
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  function mount(): HTMLElement {
    panel = new StrategicPosturePanel();
    const element = panel.getElement();
    document.body.appendChild(element);
    return element;
  }

  it('transitions a hung fetch to an honest unavailable state', async () => {
    fetchCachedTheaterPosture.mockReturnValue(new Promise(() => {}));
    const element = mount();
    // Panel content is debounce-applied on a timer; advance past it while the
    // posture fetch is still pending to observe the loading state.
    await vi.advanceTimersByTimeAsync(500);
    expect(element.querySelector('.posture-loading')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(13_000);
    await flushMicrotasks();

    expect(element.querySelector('.posture-loading')).toBeNull();
    expect(element.textContent).toContain('Tracking unavailable');
    expect(element.querySelector('[data-panel-retry]')).not.toBeNull();
    // Nothing may claim an in-progress stream connection.
    expect(element.textContent).not.toMatch(/connecting/i);
  });

  it('falls back to last-known-good posture with a stale warning on timeout', async () => {
    fetchCachedTheaterPosture.mockReturnValue(new Promise(() => {}));
    getCachedPosture.mockReturnValue({
      postures: [posture()],
      timestamp: new Date('2026-08-08T10:00:00Z').toISOString(),
      stale: true,
    });
    const element = mount();

    await vi.advanceTimersByTimeAsync(13_000);
    await flushMicrotasks();

    expect(element.querySelector('.posture-loading')).toBeNull();
    expect(element.textContent).toContain('BALTIC');
    expect(element.querySelector('.posture-stale-warning')).not.toBeNull();
  });

  it('still renders live data when the fetch resolves normally', async () => {
    fetchCachedTheaterPosture.mockResolvedValue({
      postures: [posture({ shortName: 'TAIWAN', theaterId: 'taiwan-theater', theaterName: 'Taiwan Strait' })],
      timestamp: new Date('2026-08-08T10:00:00Z').toISOString(),
      stale: false,
    });
    const element = mount();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(element.querySelector('.posture-loading')).toBeNull();
    expect(element.textContent).toContain('TAIWAN');
    expect(element.querySelector('.posture-stale-warning')).toBeNull();
  });
});
