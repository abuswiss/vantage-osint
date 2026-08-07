import { toApiUrl } from '@/services/runtime';

/**
 * Typed client for /api/brief-history — the archived world-brief snapshots
 * written by api/vantage-refresh.js and served by api/brief-history.js.
 * Fetch conventions mirror insights-loader.ts (toApiUrl + AbortSignal timeout,
 * credentials omitted: the history archive is public data).
 *
 * Unlike insights-loader these wrappers THROW on network/HTTP failure instead
 * of returning null, so history UI can distinguish "empty archive" (a resolved
 * response with entries: []) from "backend unavailable" (a rejection).
 */

/** One row in the history list (newest-first). */
export interface BriefHistoryEntry {
  generatedAt: string;
  clusterCount: number | null;
  /** First sentence of the archived worldBrief, citations stripped, <=140 chars. */
  headline: string;
}

export interface BriefHistoryResponse {
  entries: BriefHistoryEntry[];
}

/** worldBriefSources entry as trimmed for the archive. */
export interface ArchivedBriefSource {
  index: number;
  source: string;
  title: string;
  url: string;
}

/** Full archived snapshot — the trimmed subset of ServerInsights we retain. */
export interface ArchivedBriefSnapshot {
  generatedAt: string;
  worldBrief: string;
  briefStoryLines?: Array<{ n: number | null; text: string }>;
  worldBriefSources: ArchivedBriefSource[];
  clusterCount: number | null;
  provenance?: {
    storiesConsidered: number;
    sourcesConsidered: number;
    selectionDrops?: { admissibility: number; sourceCap: number; overflow: number };
  };
}

export interface BriefDiffKeptLine {
  /** The line as it appears in snapshot `b`. */
  text: string;
  /** The matched line from snapshot `a`. */
  previousText: string;
  /** True when the texts differ beyond citation/punctuation/case drift. */
  changed: boolean;
}

/**
 * Diff of brief lines from snapshot `a` to snapshot `b`:
 * `added` = lines present in `b` but not matched in `a`,
 * `removed` = lines in `a` with no match in `b`,
 * `kept` = matched pairs (token Jaccard >= 0.5 on normalized text).
 */
export interface BriefDiffResponse {
  a: { generatedAt: string | null };
  b: { generatedAt: string | null };
  added: string[];
  removed: string[];
  kept: BriefDiffKeptLine[];
}

/** A diff endpoint selector: a generatedAt timestamp, or a convenience alias. */
export type BriefDiffSelector = 'latest' | 'yesterday' | (string & {});

const DEFAULT_TIMEOUT_MS = 8_000;

async function fetchJson<T>(path: string, timeoutMs: number): Promise<T> {
  const resp = await fetch(toApiUrl(path), {
    signal: AbortSignal.timeout(timeoutMs),
    credentials: 'omit',
  });
  if (!resp.ok) {
    let message = `brief-history request failed: HTTP ${resp.status}`;
    try {
      const body = (await resp.json()) as { error?: string };
      if (body?.error) message = `${message} (${body.error})`;
    } catch {
      // Non-JSON error body; the status-only message stands.
    }
    throw new Error(message);
  }
  return (await resp.json()) as T;
}

/** Newest-first list of archived briefs (max 100). Empty archive → { entries: [] }. */
export function fetchBriefHistory(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<BriefHistoryResponse> {
  return fetchJson<BriefHistoryResponse>('/api/brief-history', timeoutMs);
}

/** Full archived snapshot for an exact generatedAt timestamp. */
export function fetchBriefSnapshot(
  at: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ArchivedBriefSnapshot> {
  return fetchJson<ArchivedBriefSnapshot>(
    `/api/brief-history?at=${encodeURIComponent(at)}`,
    timeoutMs,
  );
}

/**
 * Diff two archived snapshots. Each selector is a generatedAt timestamp or the
 * aliases 'latest' / 'yesterday' (entry closest to 24h before the newest).
 */
export function fetchBriefDiff(
  a: BriefDiffSelector,
  b: BriefDiffSelector,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<BriefDiffResponse> {
  return fetchJson<BriefDiffResponse>(
    `/api/brief-history?diff=${encodeURIComponent(a)},${encodeURIComponent(b)}`,
    timeoutMs,
  );
}
