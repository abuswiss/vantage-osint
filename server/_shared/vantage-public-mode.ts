import {
  isVantagePublicFullAccessRpcRequest,
  isVantagePublicRpcRequest,
} from '../../src/shared/vantage-public-rpc';

function readBoolean(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

/**
 * Server-side mirror of the Vite product flag. VANTAGE_PUBLIC_MODE is an
 * optional explicit runtime override; existing deployments can continue to
 * use VITE_VANTAGE_PUBLIC_MODE for both the build and server functions.
 */
export function isVantagePublicServerMode(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return readBoolean(env.VANTAGE_PUBLIC_MODE ?? env.VITE_VANTAGE_PUBLIC_MODE);
}

export function isPublicVantageGatewayRequest(request: Request): boolean {
  return isVantagePublicServerMode()
    && isVantagePublicRpcRequest(request.url, request.method);
}

export function isPublicVantageFullAccessRequest(request: Request): boolean {
  return isVantagePublicServerMode()
    && isVantagePublicFullAccessRpcRequest(request.url, request.method);
}
