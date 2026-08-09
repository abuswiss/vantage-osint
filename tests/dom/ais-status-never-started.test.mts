/**
 * Regression: getAisStatus() floored availability at 'unknown' whenever
 * polling had never started (pollingStartedAt === 0) — e.g. relay configured
 * but the ships layer off — so consumers like Strategic Posture rendered
 * "checking" forever. 'unknown' is only honest while a first poll can still
 * land: polling actually started and still within the first stale window.
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

import { getAisStatus, initAisStream, isAisConfigured } from '@/services/maritime';

describe('getAisStatus never-started floor', () => {
  it('reads unavailable, not unknown, when polling never started', () => {
    expect(isAisConfigured()).toBe(true);
    const status = getAisStatus();
    expect(status.connected).toBe(false);
    expect(status.availability).toBe('unavailable');
  });

  it('reads unknown only after polling starts, while a first poll can still land', () => {
    initAisStream();
    expect(getAisStatus().availability).toBe('unknown');
  });
});
