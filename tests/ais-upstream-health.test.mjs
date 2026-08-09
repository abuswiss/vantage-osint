import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  deriveAisUpstreamState,
  isAisUpstreamUsable,
  shouldRecycleAisUpstream,
} = require('../scripts/shared/ais-upstream-health.cjs');

const NOW = 1_000_000;
const base = {
  configured: true,
  socketOpen: true,
  openedAt: NOW - 10_000,
  lastMessageAt: 0,
  now: NOW,
  firstMessageTimeoutMs: 90_000,
  staleMessageTimeoutMs: 300_000,
};

describe('AIS upstream data-plane health', () => {
  it('does not call an open socket live until a frame arrives', () => {
    assert.equal(deriveAisUpstreamState(base), 'connecting');
    assert.equal(isAisUpstreamUsable(base), false);
  });

  it('classifies an open zero-frame socket as silent after the first-frame budget', () => {
    const input = { ...base, openedAt: NOW - 90_001 };
    assert.equal(deriveAisUpstreamState(input), 'silent');
    assert.equal(shouldRecycleAisUpstream(input), true);
  });

  it('requires recent frames and recycles a formerly-live stale socket', () => {
    const live = { ...base, lastMessageAt: NOW - 1_000 };
    const stale = { ...base, lastMessageAt: NOW - 300_001 };
    assert.equal(deriveAisUpstreamState(live), 'live');
    assert.equal(isAisUpstreamUsable(live), true);
    assert.equal(deriveAisUpstreamState(stale), 'stale');
    assert.equal(shouldRecycleAisUpstream(stale), true);
  });

  it('distinguishes disabled, connecting, and disconnected states', () => {
    assert.equal(deriveAisUpstreamState({ ...base, configured: false }), 'disabled');
    assert.equal(deriveAisUpstreamState({ ...base, socketOpen: false, socketConnecting: true }), 'connecting');
    assert.equal(deriveAisUpstreamState({ ...base, socketOpen: false }), 'disconnected');
  });
});
