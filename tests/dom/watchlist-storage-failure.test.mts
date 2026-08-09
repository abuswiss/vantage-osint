/**
 * Persistence honesty: toggleCountry/toggleTopic returned the mutated
 * in-memory array even when localStorage.setItem threw (quota/security), so
 * a failed add still reported "now watched" and subscribers were notified of
 * a change no reader could observe. The result must come from persisted
 * state, and notify() must fire only on successful writes — including for
 * setAlertPrefs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getAlertPrefs,
  getWatchlist,
  isWatched,
  setAlertPrefs,
  subscribe,
  toggleCountry,
  toggleTopic,
} from '@/services/watchlist';

function failSetItem(): void {
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new DOMException('quota exceeded', 'QuotaExceededError');
  });
}

describe('watchlist storage-failure honesty', () => {
  afterEach(() => {
    // restoreMocks (vitest config) restores the setItem spy before this runs.
    localStorage.clear();
  });

  it('a country add that fails to persist reports not-watched and does not notify', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    failSetItem();

    expect(toggleCountry('DE')).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    vi.mocked(localStorage.setItem).mockRestore();
    expect(isWatched('country', 'DE')).toBe(false);
    expect(getWatchlist().countries).toEqual([]);
    unsubscribe();
  });

  it('a country removal that fails to persist reports still-watched', () => {
    expect(toggleCountry('DE')).toBe(true);
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    failSetItem();

    expect(toggleCountry('DE')).toBe(true);
    expect(listener).not.toHaveBeenCalled();

    vi.mocked(localStorage.setItem).mockRestore();
    expect(isWatched('country', 'DE')).toBe(true);
    unsubscribe();
  });

  it('a topic add that fails to persist reports not-watched and does not notify', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    failSetItem();

    expect(toggleTopic('sanctions')).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    vi.mocked(localStorage.setItem).mockRestore();
    expect(isWatched('topic', 'sanctions')).toBe(false);
    unsubscribe();
  });

  it('setAlertPrefs neither notifies nor pretends prefs changed on a failed write', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    failSetItem();

    setAlertPrefs({ enabled: true, escalationThreshold: 90 });
    expect(listener).not.toHaveBeenCalled();

    vi.mocked(localStorage.setItem).mockRestore();
    expect(getAlertPrefs()).toEqual({ enabled: false, escalationThreshold: 75 });
    unsubscribe();
  });

  it('successful writes still notify and report the persisted state', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    expect(toggleCountry('UA')).toBe(true);
    setAlertPrefs({ enabled: true });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(isWatched('country', 'UA')).toBe(true);
    expect(getAlertPrefs().enabled).toBe(true);
    unsubscribe();
  });
});
