/**
 * Baseline selection for the "since your last visit" brief diff.
 *
 * The brief archive is a bounded rolling window (~400 entries), so a returning
 * user's last visit may fall outside it. A diff is only honest when an archive
 * entry exists reasonably close to that visit — otherwise the comparison
 * silently spans a different period than the user believes. Callers must treat
 * null as "baseline unavailable" and say so, never substitute a distant entry.
 */

export interface BriefBaselineCandidate {
  generatedAt: string;
}

/** Maximum (last visit − archive) gap for an entry to count as a baseline. */
export const SINCE_VISIT_MAX_DRIFT_MS = 12 * 60 * 60 * 1000;

/**
 * Pick the newest archive entry generated at or before `previousVisitMs`, or
 * null when the user has no recorded previous visit or no such entry lands
 * within `maxDriftMs` before it.
 *
 * A snapshot generated *after* the visit is never a valid baseline, even when
 * it is nearer in absolute time: it already contains changes that happened
 * after the user left, so diffing against it silently drops exactly the
 * changes "since your last visit" is supposed to surface.
 */
export function pickSinceBaseline<T extends BriefBaselineCandidate>(
  entries: readonly T[],
  previousVisitMs: number,
  maxDriftMs: number = SINCE_VISIT_MAX_DRIFT_MS,
): T | null {
  if (!Number.isFinite(previousVisitMs) || previousVisitMs <= 0) return null;
  let best: T | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const at = Date.parse(entry.generatedAt);
    if (!Number.isFinite(at)) continue;
    if (at > previousVisitMs) continue;
    if (previousVisitMs - at > maxDriftMs) continue;
    if (at > bestAt) {
      best = entry;
      bestAt = at;
    }
  }
  return best;
}
