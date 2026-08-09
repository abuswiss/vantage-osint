import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  VANTAGE_PUBLIC_RPC_PATHS,
  isVantagePublicFullAccessRpcRequest,
  isVantagePublicRpcRequest,
} from '../src/shared/vantage-public-rpc.ts';
import { isVantagePublicServerMode } from '../server/_shared/vantage-public-mode.ts';

describe('Vantage public access policy', () => {
  it('accepts only the audited path and HTTP-method pairs', () => {
    assert.equal(
      isVantagePublicRpcRequest(
        'https://vantage-osint.vercel.app/api/resilience/v1/get-resilience-score?countryCode=UA',
        'GET',
      ),
      true,
    );
    assert.equal(
      isVantagePublicRpcRequest('/api/resilience/v1/get-resilience-score', 'POST'),
      false,
    );
    assert.equal(
      isVantagePublicRpcRequest('/api/scenario/v1/run-scenario', 'POST'),
      true,
    );
    assert.equal(
      isVantagePublicRpcRequest('/api/scenario/v1/run-scenario', 'GET'),
      false,
    );
    assert.equal(
      isVantagePublicRpcRequest('/api/maritime/v1/get-vessel-snapshot', 'GET'),
      true,
    );
    assert.equal(
      isVantagePublicRpcRequest('/api/maritime/v1/get-vessel-snapshot', 'POST'),
      false,
    );
    assert.equal(
      isVantagePublicRpcRequest('/api/military/v1/list-military-flights', 'GET'),
      true,
    );
    for (const path of [
      '/api/intelligence/v1/get-country-facts',
      '/api/intelligence/v1/get-country-energy-profile',
      '/api/intelligence/v1/get-country-port-activity',
      '/api/intelligence/v1/get-country-risk',
      '/api/market/v1/get-country-stock-index',
    ]) {
      assert.equal(isVantagePublicRpcRequest(path, 'GET'), true, path);
      assert.equal(isVantagePublicRpcRequest(path, 'POST'), false, path);
    }
  });

  it('keeps the public country brief on its bounded anonymous contract', () => {
    const path = '/api/intelligence/v1/get-country-intel-brief';
    assert.equal(isVantagePublicRpcRequest(path, 'GET'), true);
    assert.equal(isVantagePublicFullAccessRpcRequest(path, 'GET'), false);
  });

  it('does not expose account, webhook, MCP, chat, or open-ended LLM routes', () => {
    for (const path of [
      '/api/chat-analyst',
      '/api/mcp-proxy',
      '/api/v2/shipping/webhooks',
      '/api/market/v1/analyze-stock',
      '/api/forecast/v1/trigger-simulation',
      '/api/intelligence/v1/deduct-situation',
    ]) {
      assert.equal(VANTAGE_PUBLIC_RPC_PATHS.has(path), false, path);
    }
  });

  it('supports the existing Vite flag plus an explicit server override', () => {
    assert.equal(isVantagePublicServerMode({ VITE_VANTAGE_PUBLIC_MODE: 'true' }), true);
    assert.equal(isVantagePublicServerMode({ VITE_VANTAGE_PUBLIC_MODE: '1' }), true);
    assert.equal(isVantagePublicServerMode({ VITE_VANTAGE_PUBLIC_MODE: 'false' }), false);
    assert.equal(
      isVantagePublicServerMode({
        VANTAGE_PUBLIC_MODE: 'false',
        VITE_VANTAGE_PUBLIC_MODE: 'true',
      }),
      false,
    );
  });

  it('lets anonymous Vantage traffic through the gateway without opening unsafe premium routes', async () => {
    const previousPublicMode = process.env.VITE_VANTAGE_PUBLIC_MODE;
    const previousRuntimeOverride = process.env.VANTAGE_PUBLIC_MODE;
    const previousKeys = process.env.WORLDMONITOR_VALID_KEYS;
    process.env.VITE_VANTAGE_PUBLIC_MODE = 'true';
    delete process.env.VANTAGE_PUBLIC_MODE;
    delete process.env.WORLDMONITOR_VALID_KEYS;

    try {
      const { createDomainGateway } = await import('../server/gateway.ts');
      const { isCallerPremium, requirePremiumRpcAccess } = await import('../server/_shared/premium-check.ts');
      const gateway = createDomainGateway([
        {
          method: 'GET',
          path: '/api/resilience/v1/get-resilience-score',
          handler: async () => Response.json({ ok: true }),
        },
        {
          method: 'GET',
          path: '/api/intelligence/v1/get-country-intel-brief',
          handler: async () => Response.json({ ok: true }),
        },
        {
          method: 'GET',
          path: '/api/maritime/v1/get-vessel-snapshot',
          handler: async () => Response.json({ ok: true }),
        },
        {
          method: 'GET',
          path: '/api/military/v1/list-military-flights',
          handler: async () => Response.json({ ok: true }),
        },
        ...[
          '/api/intelligence/v1/get-country-facts',
          '/api/intelligence/v1/get-country-energy-profile',
          '/api/intelligence/v1/get-country-port-activity',
          '/api/intelligence/v1/get-country-risk',
          '/api/market/v1/get-country-stock-index',
        ].map((path) => ({
          method: 'GET' as const,
          path,
          handler: async () => Response.json({ ok: true }),
        })),
        {
          method: 'GET',
          path: '/api/market/v1/analyze-stock',
          handler: async () => Response.json({ ok: true }),
        },
        {
          method: 'POST',
          path: '/api/scenario/v1/run-scenario',
          handler: async () => Response.json({ ok: true }),
        },
      ]);
      const origin = { Origin: 'https://vantage-osint.vercel.app' };

      const score = await gateway(new Request(
        'https://vantage-osint.vercel.app/api/resilience/v1/get-resilience-score?countryCode=UA',
        { headers: origin },
      ));
      assert.equal(score.status, 200);

      const brief = await gateway(new Request(
        'https://vantage-osint.vercel.app/api/intelligence/v1/get-country-intel-brief?countryCode=UA',
        { headers: origin },
      ));
      assert.equal(brief.status, 200, 'public brief must not fall into the paid direct-LLM user meter');

      const vessels = await gateway(new Request(
        'https://vantage-osint.vercel.app/api/maritime/v1/get-vessel-snapshot?includeCandidates=true',
        { headers: origin },
      ));
      assert.notEqual(vessels.status, 401);
      assert.notEqual(vessels.status, 403, 'vessel snapshots may fail closed on a missing test limiter, never on account access');

      const flights = await gateway(new Request(
        'https://vantage-osint.vercel.app/api/military/v1/list-military-flights?sw_lat=20&sw_lon=-130&ne_lat=72&ne_lon=-50',
        { headers: origin },
      ));
      assert.notEqual(flights.status, 401);
      assert.notEqual(flights.status, 403, 'flight positions may fail closed on a missing test limiter, never on account access');

      for (const path of [
        '/api/intelligence/v1/get-country-facts?countryCode=UA',
        '/api/intelligence/v1/get-country-energy-profile?countryCode=UA',
        '/api/intelligence/v1/get-country-port-activity?countryCode=UA',
        '/api/intelligence/v1/get-country-risk?countryCode=UA',
        '/api/market/v1/get-country-stock-index?countryCode=UA',
      ]) {
        const response = await gateway(new Request(
          `https://vantage-osint.vercel.app${path}`,
          { headers: origin },
        ));
        assert.equal(response.status, 200, `${path} must be account-free in public Vantage`);
      }

      const scenarioRequest = new Request(
        'https://vantage-osint.vercel.app/api/scenario/v1/run-scenario',
        { method: 'POST', headers: origin },
      );
      const scenario = await gateway(scenarioRequest);
      assert.notEqual(scenario.status, 401);
      assert.notEqual(scenario.status, 403, 'scenario may fail closed on a missing test limiter, never on account access');

      class TestApiError extends Error {
        statusCode: number;
        body: string;

        constructor(statusCode: number, message: string, body: string) {
          super(message);
          this.statusCode = statusCode;
          this.body = body;
        }
      }
      assert.equal(await isCallerPremium(new Request(
        'https://vantage-osint.vercel.app/api/resilience/v1/get-resilience-score?countryCode=UA',
      )), true, 'shared-data handlers must enter their populated response branch');
      await assert.doesNotReject(requirePremiumRpcAccess(
        scenarioRequest,
        TestApiError,
        'PRO subscription required',
      ));

      const unsafe = await gateway(new Request(
        'https://vantage-osint.vercel.app/api/market/v1/analyze-stock?symbol=AAPL',
        { headers: origin },
      ));
      assert.equal(unsafe.status, 401);
    } finally {
      if (previousPublicMode === undefined) delete process.env.VITE_VANTAGE_PUBLIC_MODE;
      else process.env.VITE_VANTAGE_PUBLIC_MODE = previousPublicMode;
      if (previousRuntimeOverride === undefined) delete process.env.VANTAGE_PUBLIC_MODE;
      else process.env.VANTAGE_PUBLIC_MODE = previousRuntimeOverride;
      if (previousKeys === undefined) delete process.env.WORLDMONITOR_VALID_KEYS;
      else process.env.WORLDMONITOR_VALID_KEYS = previousKeys;
    }
  });
});
