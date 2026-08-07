/**
 * Watchlist + alert preference store for the ops shell.
 *
 * Persists watched countries (ISO2) and topics (lowercase keywords) under
 * 'wm-watchlist-v1', and browser-notification preferences under
 * 'wm-watchlist-alerts-v1'. Every read re-parses localStorage defensively, so
 * a corrupt or foreign value degrades to an empty list instead of throwing.
 * Change notification is a simple in-page listener set — no cross-tab sync.
 */

const WATCHLIST_KEY = 'wm-watchlist-v1';
const ALERT_PREFS_KEY = 'wm-watchlist-alerts-v1';
const MAX_ENTRIES = 50;
const MAX_TOPIC_LENGTH = 64;

export interface Watchlist {
  countries: string[];
  topics: string[];
}

export interface AlertPrefs {
  enabled: boolean;
  escalationThreshold: number;
}

const DEFAULT_PREFS: AlertPrefs = { enabled: false, escalationThreshold: 75 };

type WatchlistListener = () => void;
const listeners = new Set<WatchlistListener>();

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One broken subscriber must not starve the rest.
    }
  }
}

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage unavailable — in-memory callers still notify.
  }
}

function normalizeCountry(code: string): string | null {
  const iso = code.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(iso) ? iso : null;
}

function normalizeTopic(topic: string): string | null {
  const value = topic.trim().toLowerCase().slice(0, MAX_TOPIC_LENGTH);
  return value.length > 0 ? value : null;
}

function sanitizeWatchlist(value: unknown): Watchlist {
  const out: Watchlist = { countries: [], topics: [] };
  if (typeof value !== 'object' || value === null) return out;
  const { countries, topics } = value as { countries?: unknown; topics?: unknown };
  if (Array.isArray(countries)) {
    for (const entry of countries) {
      if (typeof entry !== 'string') continue;
      const iso = normalizeCountry(entry);
      if (iso && !out.countries.includes(iso) && out.countries.length < MAX_ENTRIES) {
        out.countries.push(iso);
      }
    }
  }
  if (Array.isArray(topics)) {
    for (const entry of topics) {
      if (typeof entry !== 'string') continue;
      const topic = normalizeTopic(entry);
      if (topic && !out.topics.includes(topic) && out.topics.length < MAX_ENTRIES) {
        out.topics.push(topic);
      }
    }
  }
  return out;
}

export function getWatchlist(): Watchlist {
  return sanitizeWatchlist(readJson(WATCHLIST_KEY));
}

/** Toggle a country on the watchlist. Returns true when it is now watched. */
export function toggleCountry(code: string): boolean {
  const iso = normalizeCountry(code);
  if (!iso) return false;
  const list = getWatchlist();
  const index = list.countries.indexOf(iso);
  if (index >= 0) list.countries.splice(index, 1);
  else if (list.countries.length < MAX_ENTRIES) list.countries.push(iso);
  writeJson(WATCHLIST_KEY, list);
  notify();
  return index < 0;
}

/** Toggle a topic keyword on the watchlist. Returns true when it is now watched. */
export function toggleTopic(rawTopic: string): boolean {
  const topic = normalizeTopic(rawTopic);
  if (!topic) return false;
  const list = getWatchlist();
  const index = list.topics.indexOf(topic);
  if (index >= 0) list.topics.splice(index, 1);
  else if (list.topics.length < MAX_ENTRIES) list.topics.push(topic);
  writeJson(WATCHLIST_KEY, list);
  notify();
  return index < 0;
}

export function isWatched(kind: 'country' | 'topic', value: string): boolean {
  const list = getWatchlist();
  if (kind === 'country') {
    const iso = normalizeCountry(value);
    return iso !== null && list.countries.includes(iso);
  }
  const topic = normalizeTopic(value);
  return topic !== null && list.topics.includes(topic);
}

export function getAlertPrefs(): AlertPrefs {
  const raw = readJson(ALERT_PREFS_KEY);
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_PREFS };
  const { enabled, escalationThreshold } = raw as { enabled?: unknown; escalationThreshold?: unknown };
  const threshold = typeof escalationThreshold === 'number' && Number.isFinite(escalationThreshold)
    ? Math.min(100, Math.max(0, Math.round(escalationThreshold)))
    : DEFAULT_PREFS.escalationThreshold;
  return { enabled: enabled === true, escalationThreshold: threshold };
}

export function setAlertPrefs(patch: Partial<AlertPrefs>): void {
  const next = { ...getAlertPrefs(), ...patch };
  next.escalationThreshold = Math.min(100, Math.max(0, Math.round(next.escalationThreshold)));
  next.enabled = next.enabled === true;
  writeJson(ALERT_PREFS_KEY, next);
  notify();
}

/** Subscribe to watchlist/alert-pref changes. Returns an unsubscribe function. */
export function subscribe(listener: WatchlistListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
