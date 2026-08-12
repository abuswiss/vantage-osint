/**
 * Local monitor + alert preference store for the ops shell.
 *
 * The original single watchlist is migrated lazily into a named local monitor.
 * Every read re-parses localStorage defensively, so a corrupt or foreign value
 * degrades to one empty default monitor instead of throwing.
 * Change notification is an in-page listener set, plus a `storage` listener
 * so edits in another tab re-notify here — safe precisely because every
 * getter re-reads localStorage rather than holding an in-memory copy.
 */

const WATCHLIST_KEY = 'wm-watchlist-v1';
const ALERT_PREFS_KEY = 'wm-watchlist-alerts-v1';
const MONITORS_KEY = 'wm-monitors-v1';
const DEFAULT_MONITOR_ID = 'default';
const MAX_ENTRIES = 50;
const MAX_TOPIC_LENGTH = 64;
const MAX_MONITORS = 8;
const MAX_MONITOR_NAME_LENGTH = 40;
const MAX_BASELINE_SIGNALS = 160;

export interface Watchlist {
  countries: string[];
  topics: string[];
}

export interface AlertPrefs {
  enabled: boolean;
  escalationThreshold: number;
}

export interface MonitorSignalSnapshot {
  id: string;
  sourceCount: number;
  title?: string;
}

export interface MonitorBaseline {
  capturedAt: number;
  signals: MonitorSignalSnapshot[];
}

export interface MonitorWorkspace extends Watchlist {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  baseline: MonitorBaseline | null;
}

interface MonitorState {
  activeId: string;
  monitors: MonitorWorkspace[];
}

export interface MonitorPulse {
  baselineAt: number | null;
  newCount: number;
  strengthenedCount: number;
  noLongerCurrentCount: number;
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

/** Returns whether the value was actually persisted. */
function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Quota exceeded or storage unavailable — nothing changed on disk, so
    // callers must not notify or report the mutation as having happened.
    return false;
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

function normalizeMonitorName(name: string): string | null {
  const value = name.trim().replace(/\s+/g, ' ').slice(0, MAX_MONITOR_NAME_LENGTH);
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

function sanitizeSignalSnapshot(value: unknown): MonitorSignalSnapshot[] {
  if (!Array.isArray(value)) return [];
  const signals: MonitorSignalSnapshot[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as { id?: unknown; sourceCount?: unknown; title?: unknown };
    if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 256 || seen.has(raw.id)) continue;
    const sourceCount = typeof raw.sourceCount === 'number' && Number.isFinite(raw.sourceCount)
      ? Math.max(1, Math.round(raw.sourceCount))
      : 1;
    const title = typeof raw.title === 'string' ? raw.title.slice(0, 240) : undefined;
    signals.push({ id: raw.id, sourceCount, ...(title && { title }) });
    seen.add(raw.id);
    if (signals.length >= MAX_BASELINE_SIGNALS) break;
  }
  return signals;
}

function defaultMonitor(watchlist: Watchlist = { countries: [], topics: [] }): MonitorWorkspace {
  const now = Date.now();
  return {
    id: DEFAULT_MONITOR_ID,
    name: 'My monitor',
    countries: watchlist.countries,
    topics: watchlist.topics,
    createdAt: now,
    updatedAt: now,
    baseline: null,
  };
}

function sanitizeMonitor(value: unknown): MonitorWorkspace | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Partial<MonitorWorkspace>;
  if (typeof raw.id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(raw.id)) return null;
  const name = typeof raw.name === 'string' ? normalizeMonitorName(raw.name) : null;
  if (!name) return null;
  const watchlist = sanitizeWatchlist(raw);
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt;
  let baseline: MonitorBaseline | null = null;
  if (typeof raw.baseline === 'object' && raw.baseline !== null) {
    const candidate = raw.baseline as Partial<MonitorBaseline>;
    if (typeof candidate.capturedAt === 'number' && Number.isFinite(candidate.capturedAt)) {
      baseline = {
        capturedAt: candidate.capturedAt,
        signals: sanitizeSignalSnapshot(candidate.signals),
      };
    }
  }
  return { id: raw.id, name, ...watchlist, createdAt, updatedAt, baseline };
}

function readMonitorState(): MonitorState {
  const raw = readJson(MONITORS_KEY);
  if (typeof raw === 'object' && raw !== null) {
    const candidate = raw as { activeId?: unknown; monitors?: unknown };
    const monitors = Array.isArray(candidate.monitors)
      ? candidate.monitors
        .map(sanitizeMonitor)
        .filter((monitor): monitor is MonitorWorkspace => monitor !== null)
        .slice(0, MAX_MONITORS)
      : [];
    if (monitors.length > 0) {
      const activeId = typeof candidate.activeId === 'string'
        && monitors.some((monitor) => monitor.id === candidate.activeId)
        ? candidate.activeId
        : monitors[0]!.id;
      return { activeId, monitors };
    }
  }
  return { activeId: DEFAULT_MONITOR_ID, monitors: [defaultMonitor(sanitizeWatchlist(readJson(WATCHLIST_KEY)))] };
}

function writeMonitorState(state: MonitorState): boolean {
  return writeJson(MONITORS_KEY, state);
}

function activeMonitor(state: MonitorState): MonitorWorkspace {
  return state.monitors.find((monitor) => monitor.id === state.activeId) ?? state.monitors[0]!;
}

export function getWatchlist(): Watchlist {
  const monitor = activeMonitor(readMonitorState());
  return { countries: [...monitor.countries], topics: [...monitor.topics] };
}

export function getMonitors(): MonitorWorkspace[] {
  return readMonitorState().monitors.map((monitor) => ({
    ...monitor,
    countries: [...monitor.countries],
    topics: [...monitor.topics],
    baseline: monitor.baseline
      ? { capturedAt: monitor.baseline.capturedAt, signals: [...monitor.baseline.signals] }
      : null,
  }));
}

export function getActiveMonitor(): MonitorWorkspace {
  const monitor = activeMonitor(readMonitorState());
  return {
    ...monitor,
    countries: [...monitor.countries],
    topics: [...monitor.topics],
    baseline: monitor.baseline
      ? { capturedAt: monitor.baseline.capturedAt, signals: [...monitor.baseline.signals] }
      : null,
  };
}

export function setActiveMonitor(id: string): boolean {
  const state = readMonitorState();
  if (!state.monitors.some((monitor) => monitor.id === id)) return false;
  state.activeId = id;
  if (!writeMonitorState(state)) return false;
  notify();
  return getActiveMonitor().id === id;
}

export function createMonitor(rawName: string): MonitorWorkspace | null {
  const name = normalizeMonitorName(rawName);
  if (!name) return null;
  const state = readMonitorState();
  if (state.monitors.length >= MAX_MONITORS) return null;
  const now = Date.now();
  const id = `monitor-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const monitor: MonitorWorkspace = {
    id,
    name,
    countries: [],
    topics: [],
    createdAt: now,
    updatedAt: now,
    baseline: null,
  };
  state.monitors.push(monitor);
  state.activeId = id;
  if (!writeMonitorState(state)) return null;
  notify();
  return getActiveMonitor();
}

export function renameActiveMonitor(rawName: string): boolean {
  const name = normalizeMonitorName(rawName);
  if (!name) return false;
  const state = readMonitorState();
  const monitor = activeMonitor(state);
  monitor.name = name;
  monitor.updatedAt = Date.now();
  if (!writeMonitorState(state)) return false;
  notify();
  return getActiveMonitor().name === name;
}

export function deleteActiveMonitor(): boolean {
  const state = readMonitorState();
  if (state.monitors.length <= 1) return false;
  const next = state.monitors.filter((monitor) => monitor.id !== state.activeId);
  if (next.length === state.monitors.length) return false;
  state.monitors = next;
  state.activeId = next[0]!.id;
  if (!writeMonitorState(state)) return false;
  notify();
  return true;
}

export function checkpointMonitor(id: string, signals: MonitorSignalSnapshot[], capturedAt = Date.now()): boolean {
  const state = readMonitorState();
  const monitor = state.monitors.find((candidate) => candidate.id === id);
  if (!monitor) return false;
  monitor.baseline = { capturedAt, signals: sanitizeSignalSnapshot(signals) };
  monitor.updatedAt = capturedAt;
  return writeMonitorState(state);
}

export function compareMonitorSignals(
  current: MonitorSignalSnapshot[],
  baseline: MonitorBaseline | null,
): MonitorPulse {
  if (!baseline) {
    return { baselineAt: null, newCount: 0, strengthenedCount: 0, noLongerCurrentCount: 0 };
  }
  const previous = new Map(baseline.signals.map((signal) => [signal.id, signal]));
  const currentById = new Map(sanitizeSignalSnapshot(current).map((signal) => [signal.id, signal]));
  let newCount = 0;
  let strengthenedCount = 0;
  for (const [id, signal] of currentById) {
    const prior = previous.get(id);
    if (!prior) newCount += 1;
    else if (signal.sourceCount > prior.sourceCount) strengthenedCount += 1;
  }
  let noLongerCurrentCount = 0;
  for (const id of previous.keys()) {
    if (!currentById.has(id)) noLongerCurrentCount += 1;
  }
  return { baselineAt: baseline.capturedAt, newCount, strengthenedCount, noLongerCurrentCount };
}

/**
 * Toggle a country on the watchlist. Returns true when it is now watched —
 * re-read from persisted state after the write, so an add refused by the
 * entry cap OR a failed localStorage write reports the state the store is
 * actually in instead of claiming a watch that was never stored.
 */
export function toggleCountry(code: string): boolean {
  const iso = normalizeCountry(code);
  if (!iso) return false;
  const state = readMonitorState();
  const monitor = activeMonitor(state);
  const index = monitor.countries.indexOf(iso);
  if (index >= 0) monitor.countries.splice(index, 1);
  else if (monitor.countries.length < MAX_ENTRIES) monitor.countries.push(iso);
  else return false;
  monitor.updatedAt = Date.now();
  if (writeMonitorState(state)) notify();
  return getWatchlist().countries.includes(iso);
}

/**
 * Toggle a topic keyword on the watchlist. Returns true when it is now
 * watched — re-read from persisted state (see toggleCountry).
 */
export function toggleTopic(rawTopic: string): boolean {
  const topic = normalizeTopic(rawTopic);
  if (!topic) return false;
  const state = readMonitorState();
  const monitor = activeMonitor(state);
  const index = monitor.topics.indexOf(topic);
  if (index >= 0) monitor.topics.splice(index, 1);
  else if (monitor.topics.length < MAX_ENTRIES) monitor.topics.push(topic);
  else return false;
  monitor.updatedAt = Date.now();
  if (writeMonitorState(state)) notify();
  return getWatchlist().topics.includes(topic);
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
  // Notify only when the prefs actually persisted: getAlertPrefs() re-reads
  // localStorage, so notifying after a failed write would fan out a change
  // that no reader can observe.
  if (writeJson(ALERT_PREFS_KEY, next)) notify();
}

/** Subscribe to watchlist/alert-pref changes. Returns an unsubscribe function. */
export function subscribe(listener: WatchlistListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Cross-tab sync: `storage` fires only in OTHER tabs, so this never
// double-notifies the writing tab. key === null means storage.clear().
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === WATCHLIST_KEY || event.key === MONITORS_KEY || event.key === ALERT_PREFS_KEY) {
      notify();
    }
  });
}
