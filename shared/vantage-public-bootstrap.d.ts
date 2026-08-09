export type VantagePublicBootstrapDescriptor =
  | { kind: 'tier'; tier: 'fast' | 'slow'; key: null }
  | { kind: 'weather' | 'on-demand'; tier: null; key: string };

export const CANONICAL_BOOTSTRAP_PATH: '/api/bootstrap';
export const VANTAGE_BOOTSTRAP_PATH: '/api/vantage-bootstrap';

export function classifyVantagePublicBootstrapUrl(
  input: string | URL,
  options?: { method?: string; expectedPath?: string },
): VantagePublicBootstrapDescriptor | null;

export function rewriteVantagePublicBootstrapPath(path: string, enabled: boolean): string;
