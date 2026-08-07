/**
 * Vantage's public-product policy.
 *
 * This is intentionally separate from WorldMonitor's account entitlements:
 * Vantage exposes a curated, credentials-free surface and simply omits
 * capabilities that still require a paid/user-bound provider contract.
 */
function readPublicFlag(readValue: () => string | undefined): boolean {
  try {
    const value = readValue()?.trim().toLowerCase();
    return value === '1' || value === 'true';
  } catch {
    // `import.meta.env` exists only after Vite transforms browser source. Keep
    // direct, statically auditable key access while failing closed in Node and
    // other non-Vite module runners used by tests and tooling.
    return false;
  }
}

export const VANTAGE_PUBLIC_MODE = readPublicFlag(
  () => import.meta.env.VITE_VANTAGE_PUBLIC_MODE,
);

const relayEnabled = readPublicFlag(
  () => import.meta.env.VITE_VANTAGE_RELAY_ENABLED,
);

/** Enable only after the always-on AIR/AIS relay is deployed and healthy. */
export const VANTAGE_RELAY_ENABLED = relayEnabled;

/** Two-minute UI polling; the shared server digest remains the load shield. */
export const VANTAGE_NEWS_REFRESH_MS = 2 * 60 * 1000;

/** Public Vantage never renders an upgrade/sign-in affordance for locked data. */
export function isPublicVantageCapability(premium?: 'locked' | 'enhanced'): boolean {
  return !VANTAGE_PUBLIC_MODE || premium !== 'locked';
}
