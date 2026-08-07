/**
 * Vantage's public-product policy.
 *
 * This is intentionally separate from WorldMonitor's account entitlements:
 * Vantage exposes a curated, credentials-free surface and simply omits
 * capabilities that still require a paid/user-bound provider contract.
 */
const publicModeValue = import.meta.env?.VITE_VANTAGE_PUBLIC_MODE?.trim().toLowerCase();

export const VANTAGE_PUBLIC_MODE = publicModeValue === '1' || publicModeValue === 'true';

const relayEnabledValue = import.meta.env?.VITE_VANTAGE_RELAY_ENABLED?.trim().toLowerCase();

/** Enable only after the always-on AIR/AIS relay is deployed and healthy. */
export const VANTAGE_RELAY_ENABLED = relayEnabledValue === '1' || relayEnabledValue === 'true';

/** Two-minute UI polling; the shared server digest remains the load shield. */
export const VANTAGE_NEWS_REFRESH_MS = 2 * 60 * 1000;

/** Public Vantage never renders an upgrade/sign-in affordance for locked data. */
export function isPublicVantageCapability(premium?: 'locked' | 'enhanced'): boolean {
  return !VANTAGE_PUBLIC_MODE || premium !== 'locked';
}
