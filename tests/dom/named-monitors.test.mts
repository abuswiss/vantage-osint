import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkpointMonitor,
  compareMonitorSignals,
  createMonitor,
  deleteActiveMonitor,
  getActiveMonitor,
  getMonitors,
  getWatchlist,
  setActiveMonitor,
  subscribe,
  toggleCountry,
  toggleTopic,
} from '@/services/watchlist';

describe('named local monitors', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('lazily migrates the legacy watchlist into the default named monitor', () => {
    localStorage.setItem('wm-watchlist-v1', JSON.stringify({ countries: ['ua'], topics: ['Energy'] }));

    const monitor = getActiveMonitor();
    expect(monitor.name).toBe('My monitor');
    expect(monitor.countries).toEqual(['UA']);
    expect(monitor.topics).toEqual(['energy']);
    expect(monitor.baseline).toBeNull();
  });

  it('keeps each named monitor scope and review baseline independent', () => {
    expect(toggleCountry('UA')).toBe(true);
    const first = getActiveMonitor();
    expect(checkpointMonitor(first.id, [{ id: 'alpha', sourceCount: 1 }], 1_000)).toBe(true);

    const second = createMonitor('Energy desk');
    expect(second?.name).toBe('Energy desk');
    expect(toggleTopic('oil')).toBe(true);
    expect(getWatchlist()).toEqual({ countries: [], topics: ['oil'] });
    expect(checkpointMonitor(second!.id, [{ id: 'bravo', sourceCount: 2 }], 2_000)).toBe(true);

    expect(setActiveMonitor(first.id)).toBe(true);
    expect(getWatchlist()).toEqual({ countries: ['UA'], topics: [] });
    expect(getActiveMonitor().baseline?.signals).toEqual([{ id: 'alpha', sourceCount: 1 }]);
    expect(getMonitors()).toHaveLength(2);
  });

  it('reports new, strengthened, and no-longer-current signals without calling them resolved', () => {
    expect(compareMonitorSignals([
      { id: 'kept', sourceCount: 3 },
      { id: 'new', sourceCount: 1 },
    ], {
      capturedAt: 5_000,
      signals: [
        { id: 'kept', sourceCount: 1 },
        { id: 'gone', sourceCount: 2 },
      ],
    })).toEqual({
      baselineAt: 5_000,
      newCount: 1,
      strengthenedCount: 1,
      noLongerCurrentCount: 1,
    });
  });

  it('does not create or notify when browser storage refuses the write', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    expect(createMonitor('Cannot persist')).toBeNull();
    expect(getMonitors()).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
    setItem.mockRestore();
    unsubscribe();
  });

  it('will not delete the only monitor, then selects a remaining monitor after deletion', () => {
    expect(deleteActiveMonitor()).toBe(false);
    expect(createMonitor('Second')).not.toBeNull();
    expect(deleteActiveMonitor()).toBe(true);
    expect(getActiveMonitor().name).toBe('My monitor');
  });
});
