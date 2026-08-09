/**
 * Cross-tab watchlist sync: a `storage` event for the watchlist or alert-pref
 * keys (fired by edits in another tab) must re-notify subscribers in this tab.
 * Correct because every getter re-reads localStorage — there is no in-memory
 * copy to go stale.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getWatchlist, subscribe } from '@/services/watchlist';

function fireStorage(key: string | null, newValue: string | null): void {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
}

describe('watchlist cross-tab sync', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('notifies subscribers when another tab writes the watchlist key', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    // Simulate the other tab's write: mutate storage directly (no notify()),
    // then fire the storage event the browser would deliver here.
    localStorage.setItem('wm-watchlist-v1', JSON.stringify({ countries: ['UA'], topics: [] }));
    fireStorage('wm-watchlist-v1', localStorage.getItem('wm-watchlist-v1'));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getWatchlist().countries).toEqual(['UA']);
    unsubscribe();
  });

  it('notifies subscribers for alert-pref writes and storage.clear()', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    fireStorage('wm-watchlist-alerts-v1', JSON.stringify({ enabled: true, escalationThreshold: 60 }));
    fireStorage(null, null); // storage.clear() in another tab
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('ignores unrelated keys', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    fireStorage('some-other-key', 'x');
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
