/**
 * RPCs that are part of the account-free Vantage product surface.
 *
 * Keep this list deliberately narrow. These routes either read shared,
 * precomputed data or run the existing bounded scenario worker. User-owned
 * resources, webhooks, MCP, chat, and open-ended LLM mutations do not belong
 * here even if they remain available in the account-based WorldMonitor build.
 */
const FULL_ACCESS_METHODS = new Map<string, ReadonlySet<string>>([
  ['/api/resilience/v1/get-resilience-score', new Set(['GET'])],
  ['/api/resilience/v1/get-resilience-ranking', new Set(['GET'])],
  ['/api/supply-chain/v1/get-country-chokepoint-index', new Set(['GET'])],
  ['/api/supply-chain/v1/get-bypass-options', new Set(['GET'])],
  ['/api/supply-chain/v1/get-country-cost-shock', new Set(['GET'])],
  ['/api/supply-chain/v1/get-route-explorer-lane', new Set(['GET'])],
  ['/api/supply-chain/v1/get-route-impact', new Set(['GET'])],
  ['/api/supply-chain/v1/get-country-products', new Set(['GET'])],
  ['/api/supply-chain/v1/get-multi-sector-cost-shock', new Set(['GET'])],
  ['/api/supply-chain/v1/get-sector-dependency', new Set(['GET'])],
  ['/api/economic/v1/get-national-debt', new Set(['GET'])],
  ['/api/sanctions/v1/list-sanctions-pressure', new Set(['GET'])],
  ['/api/trade/v1/list-comtrade-flows', new Set(['GET'])],
  ['/api/trade/v1/get-tariff-trends', new Set(['GET'])],
  ['/api/scenario/v1/run-scenario', new Set(['POST'])],
  ['/api/scenario/v1/get-scenario-status', new Set(['GET'])],
]);

/**
 * Public at the gateway, but intentionally not promoted to "premium" inside
 * the handler. The country brief already has a safe anonymous contract: it
 * ignores caller-supplied prompt context and shares one bounded cache entry per
 * country/language. Retaining that contract prevents public visitors from
 * minting unbounded LLM cache keys.
 */
const ANONYMOUS_CONTRACT_METHODS = new Map<string, ReadonlySet<string>>([
  ['/api/intelligence/v1/get-country-intel-brief', new Set(['GET'])],
]);

export const VANTAGE_PUBLIC_RPC_PATHS: ReadonlySet<string> = new Set([
  ...FULL_ACCESS_METHODS.keys(),
  ...ANONYMOUS_CONTRACT_METHODS.keys(),
]);

function pathnameOf(urlOrPath: string): string {
  try {
    return new URL(urlOrPath, 'https://vantage-osint.vercel.app').pathname;
  } catch {
    return urlOrPath.split('?')[0] ?? urlOrPath;
  }
}

function matches(
  table: ReadonlyMap<string, ReadonlySet<string>>,
  urlOrPath: string,
  method: string,
): boolean {
  return table.get(pathnameOf(urlOrPath))?.has(method.trim().toUpperCase()) === true;
}

/** True when this exact path + method is account-free in the Vantage build. */
export function isVantagePublicRpcRequest(urlOrPath: string, method: string): boolean {
  return matches(FULL_ACCESS_METHODS, urlOrPath, method)
    || matches(ANONYMOUS_CONTRACT_METHODS, urlOrPath, method);
}

/**
 * True when the handler should expose its formerly-Pro shared-data branch in
 * public Vantage. This excludes the country brief's safer anonymous branch.
 */
export function isVantagePublicFullAccessRpcRequest(urlOrPath: string, method: string): boolean {
  return matches(FULL_ACCESS_METHODS, urlOrPath, method);
}
