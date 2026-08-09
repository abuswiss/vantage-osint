'use strict';

/**
 * Derive data-plane health from actual AIS frames, not merely TCP/WebSocket
 * state. AIS providers can leave a socket open indefinitely while delivering
 * no subscription data; treating that as connected makes every downstream
 * snapshot and health check lie.
 */
function deriveAisUpstreamState({
  configured,
  socketOpen,
  socketConnecting = false,
  openedAt = 0,
  lastMessageAt = 0,
  now = Date.now(),
  firstMessageTimeoutMs = 90_000,
  staleMessageTimeoutMs = 5 * 60_000,
}) {
  if (!configured) return 'disabled';
  if (socketOpen) {
    if (lastMessageAt > 0) {
      return now - lastMessageAt <= staleMessageTimeoutMs ? 'live' : 'stale';
    }
    return openedAt > 0 && now - openedAt <= firstMessageTimeoutMs ? 'connecting' : 'silent';
  }
  if (socketConnecting) return 'connecting';
  return 'disconnected';
}

function isAisUpstreamUsable(input) {
  return deriveAisUpstreamState(input) === 'live';
}

function shouldRecycleAisUpstream(input) {
  const state = deriveAisUpstreamState(input);
  return state === 'silent' || state === 'stale';
}

module.exports = {
  deriveAisUpstreamState,
  isAisUpstreamUsable,
  shouldRecycleAisUpstream,
};
