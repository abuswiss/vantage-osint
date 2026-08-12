import {
  PUBLIC_WEATHER_BOOTSTRAP_KEY,
  bootstrapTierKeyNames,
} from './bootstrap-tier-keys.js';

export const CANONICAL_BOOTSTRAP_PATH = '/api/bootstrap';
export const VANTAGE_BOOTSTRAP_PATH = '/api/vantage-bootstrap';

const PUBLIC_ON_DEMAND_KEYS = new Set(bootstrapTierKeyNames('on-demand'));

function normalizedPathname(pathname) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

/**
 * Classify the only canonical bootstrap requests that are public by contract.
 * Anything with an extra/duplicate parameter, multiple keys, or a non-GET
 * method fails closed.
 */
export function classifyVantagePublicBootstrapUrl(
  input,
  { method = 'GET', expectedPath = CANONICAL_BOOTSTRAP_PATH } = {},
) {
  if (String(method).toUpperCase() !== 'GET') return null;

  let url;
  try {
    url = input instanceof URL ? input : new URL(input, 'https://vantage.invalid');
  } catch {
    return null;
  }

  if (url.hash || normalizedPathname(url.pathname) !== expectedPath) return null;

  const paramNames = Array.from(url.searchParams.keys());
  const publicFlags = url.searchParams.getAll('public');
  if (publicFlags.length !== 1 || publicFlags[0] !== '1') return null;

  if (paramNames.every((name) => name === 'tier' || name === 'public')) {
    const tiers = url.searchParams.getAll('tier');
    if (tiers.length !== 1 || (tiers[0] !== 'fast' && tiers[0] !== 'slow')) return null;
    return { kind: 'tier', tier: tiers[0], key: null };
  }

  if (!paramNames.every((name) => name === 'keys' || name === 'public')) return null;
  const keys = url.searchParams.getAll('keys');
  if (keys.length !== 1) return null;
  const key = keys[0];
  if (key === PUBLIC_WEATHER_BOOTSTRAP_KEY) {
    return { kind: 'weather', tier: null, key };
  }
  if (!PUBLIC_ON_DEMAND_KEYS.has(key)) return null;
  return { kind: 'on-demand', tier: null, key };
}

/** Rewrite only audited relative public URLs for the Vantage browser bundle. */
export function rewriteVantagePublicBootstrapPath(path, enabled) {
  if (!enabled || typeof path !== 'string' || !path.startsWith('/')) return path;
  const descriptor = classifyVantagePublicBootstrapUrl(path);
  if (!descriptor) return path;

  const url = new URL(path, 'https://vantage.invalid');
  return `${VANTAGE_BOOTSTRAP_PATH}${url.search}`;
}
