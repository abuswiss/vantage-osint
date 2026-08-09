/**
 * Regression: disconnectAisStream() never reset pollingStartedAt, so a
 * disconnect followed by a re-enable outside the initial stale window
 * inherited the long-expired attempt clock and getAisStatus() classified the
 * brand-new polling lifecycle as 'unavailable' before its first poll could
 * land. Every polling lifecycle must open its own "first poll can still
 * land" window.
 *
 * Own file on purpose: module state in @/services/maritime is per-file
 * (isolate: true), so no poll from another test can mutate
 * lastPollAt/latestAvailability between this file's fake-time steps. The
 * fetch stub never settles, keeping lastPollAt at 0 — the availability floor
 * is then a pure function of the attempt clock under fake time.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/runtime-config', () => ({
  isFeatureAvailable: () => true,
}));
vi.mock('@/services/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/runtime')>();
  return {
    ...actual,
    startSmartPollLoop: vi.fn(() => ({ stop: vi.fn() })),
  };
});

import { disconnectAisStream, getAisStatus, initAisStream } from '@/services/maritime';

const SNAPSHOT_STALE_MS = 6 * 60 * 1000;

describe('AIS disconnect/re-enable lifecycle', () => {
  it('re-enabling after an idle disconnect opens a fresh unknown window', () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    try {
      initAisStream();
      expect(getAisStatus().availability).toBe('unknown');

      // The first poll never lands; once the initial window expires the
      // lifecycle honestly degrades to 'unavailable'.
      vi.advanceTimersByTime(SNAPSHOT_STALE_MS + 4 * 60 * 1000);
      expect(getAisStatus().availability).toBe('unavailable');

      // Disconnect resets the attempt clock; disconnected state must not
      // read as "checking".
      disconnectAisStream();
      expect(getAisStatus().availability).toBe('unavailable');

      // Re-enable: a brand-new lifecycle must read 'unknown' while its first
      // poll can still land — not inherit the expired clock from the
      // previous lifecycle and get instantly classified 'unavailable'.
      initAisStream();
      expect(getAisStatus().availability).toBe('unknown');

      // And the fresh window expires on its own schedule.
      vi.advanceTimersByTime(SNAPSHOT_STALE_MS + 1);
      expect(getAisStatus().availability).toBe('unavailable');
    } finally {
      disconnectAisStream();
      vi.useRealTimers();
    }
  });
});
