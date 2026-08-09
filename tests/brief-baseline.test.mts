/**
 * "Since your last visit" baseline selection: the diff is only honest when an
 * archived brief exists at or shortly before the recorded previous visit.
 * These tests pin two properties: distant archives are rejected (null → caller
 * says "baseline unavailable") rather than silently compared, and a snapshot
 * generated after the visit is never selected — even when it is nearer in
 * absolute time — because it would swallow exactly the changes the diff is
 * supposed to surface.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pickSinceBaseline, SINCE_VISIT_MAX_DRIFT_MS } from '../src/utils/brief-baseline.ts';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-08-01T12:00:00Z');

function entry(offsetMs: number): { generatedAt: string } {
  return { generatedAt: new Date(T0 + offsetMs).toISOString() };
}

describe('pickSinceBaseline', () => {
  it('picks the newest entry at or before the previous visit', () => {
    const entries = [entry(-6 * HOUR), entry(-2 * HOUR), entry(-30 * 60 * 1000), entry(0)];
    const picked = pickSinceBaseline(entries, T0 - 25 * 60 * 1000);
    assert.equal(picked?.generatedAt, entry(-30 * 60 * 1000).generatedAt);
  });

  it('never picks a future snapshot, even when it is closer than the prior one', () => {
    // Visit at T0−1h. The +5min-after-visit snapshot is far closer in absolute
    // time than the 3h-before-visit snapshot, but selecting it would omit any
    // brief changes that landed in the first minutes after the user left.
    const future = entry(-HOUR + 5 * 60 * 1000);
    const prior = entry(-4 * HOUR);
    const picked = pickSinceBaseline([future, prior], T0 - HOUR);
    assert.equal(picked?.generatedAt, prior.generatedAt);
  });

  it('returns null when only future snapshots exist', () => {
    const entries = [entry(HOUR), entry(2 * HOUR)];
    assert.equal(pickSinceBaseline(entries, T0), null);
  });

  it('accepts an entry generated exactly at the previous visit', () => {
    const exact = entry(-HOUR);
    const picked = pickSinceBaseline([exact, entry(-5 * HOUR)], T0 - HOUR);
    assert.equal(picked?.generatedAt, exact.generatedAt);
  });

  it('returns null when no entry at/before the visit is within the drift window', () => {
    const entries = [entry(0), entry(-HOUR)];
    const lastVisit = T0 - SINCE_VISIT_MAX_DRIFT_MS - 2 * HOUR;
    assert.equal(pickSinceBaseline(entries, lastVisit), null);
  });

  it('rejects an entry just past the drift window and accepts one just inside', () => {
    const inside = entry(-SINCE_VISIT_MAX_DRIFT_MS);
    assert.equal(pickSinceBaseline([inside], T0)?.generatedAt, inside.generatedAt);
    const outside = entry(-SINCE_VISIT_MAX_DRIFT_MS - 1);
    assert.equal(pickSinceBaseline([outside], T0), null);
  });

  it('returns null with no recorded previous visit', () => {
    assert.equal(pickSinceBaseline([entry(0)], 0), null);
    assert.equal(pickSinceBaseline([entry(0)], Number.NaN), null);
  });

  it('returns null for an empty archive', () => {
    assert.equal(pickSinceBaseline([], T0), null);
  });

  it('skips unparseable timestamps instead of matching them', () => {
    const good = entry(-HOUR);
    const picked = pickSinceBaseline([{ generatedAt: 'not-a-date' }, good], T0 - HOUR + 60_000);
    assert.equal(picked?.generatedAt, good.generatedAt);
  });

  it('honors a custom drift window', () => {
    const entries = [entry(-3 * HOUR)];
    assert.equal(pickSinceBaseline(entries, T0, 2 * HOUR), null);
    assert.equal(pickSinceBaseline(entries, T0, 4 * HOUR)?.generatedAt, entries[0]!.generatedAt);
  });
});
