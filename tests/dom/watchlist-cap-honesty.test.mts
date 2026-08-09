/**
 * Regression: at the 50-entry cap, toggleCountry/toggleTopic refused the add
 * (correct) but still returned true ("now watched"), so star buttons flipped
 * to watched while isWatched() said false. The return value must reflect the
 * list actually written.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getWatchlist, isWatched, subscribe, toggleCountry, toggleTopic } from '@/services/watchlist';

const MAX_ENTRIES = 50;

function fillCountries(): void {
  // 'AA'..'BX' — normalizeCountry accepts any two letters.
  for (let i = 0; i < MAX_ENTRIES; i++) {
    const code = String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));
    expect(toggleCountry(code)).toBe(true);
  }
}

describe('watchlist cap honesty', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('reports false when the cap refuses a country add', () => {
    fillCountries();
    expect(getWatchlist().countries.length).toBe(MAX_ENTRIES);

    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    expect(toggleCountry('ZZ')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(isWatched('country', 'ZZ')).toBe(false);
    expect(getWatchlist().countries.length).toBe(MAX_ENTRIES);
    unsubscribe();
  });

  it('still reports removals and under-cap adds correctly', () => {
    fillCountries();
    expect(toggleCountry('AA')).toBe(false); // removed
    expect(toggleCountry('ZZ')).toBe(true);  // now room for one
    expect(isWatched('country', 'ZZ')).toBe(true);
  });

  it('reports false when the cap refuses a topic add', () => {
    for (let i = 0; i < MAX_ENTRIES; i++) {
      expect(toggleTopic(`topic-${i}`)).toBe(true);
    }
    expect(toggleTopic('one-too-many')).toBe(false);
    expect(isWatched('topic', 'one-too-many')).toBe(false);
  });
});
