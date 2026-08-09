import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createDomainGateway } from '../server/gateway.ts';

const originalVantageMode = process.env.VANTAGE_PUBLIC_MODE;
const originalViteVantageMode = process.env.VITE_VANTAGE_PUBLIC_MODE;
const originalValidKeys = process.env.WORLDMONITOR_VALID_KEYS;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore('VANTAGE_PUBLIC_MODE', originalVantageMode);
  restore('VITE_VANTAGE_PUBLIC_MODE', originalViteVantageMode);
  restore('WORLDMONITOR_VALID_KEYS', originalValidKeys);
});

function testGateway(onScore: () => void, onUnsafe: () => void) {
  return createDomainGateway([
    {
      method: 'GET',
      path: '/api/resilience/v1/get-resilience-score',
      handler: async () => {
        onScore();
        return Response.json({ ok: true });
      },
    },
    {
      method: 'GET',
      path: '/api/market/v1/analyze-stock',
      handler: async () => {
        onUnsafe();
        return Response.json({ ok: true });
      },
    },
  ]);
}

describe('Vantage public RPC boundary', () => {
  it('keeps canonical WorldMonitor score access protected when the runtime override is off', async () => {
    process.env.VITE_VANTAGE_PUBLIC_MODE = 'true';
    process.env.VANTAGE_PUBLIC_MODE = 'false';
    delete process.env.WORLDMONITOR_VALID_KEYS;
    let scoreCalls = 0;
    let unsafeCalls = 0;
    const gateway = testGateway(() => { scoreCalls += 1; }, () => { unsafeCalls += 1; });

    const response = await gateway(new Request(
      'https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=UA',
      { headers: { Origin: 'https://worldmonitor.app' } },
    ));

    assert.equal(response.status, 401);
    assert.equal(scoreCalls, 0, 'protected route handler must not run before auth succeeds');
    assert.equal(unsafeCalls, 0);
  });

  it('opens only the audited Vantage route and leaves an unsafe canonical route protected', async () => {
    process.env.VANTAGE_PUBLIC_MODE = 'true';
    delete process.env.VITE_VANTAGE_PUBLIC_MODE;
    delete process.env.WORLDMONITOR_VALID_KEYS;
    let scoreCalls = 0;
    let unsafeCalls = 0;
    const gateway = testGateway(() => { scoreCalls += 1; }, () => { unsafeCalls += 1; });
    const headers = { Origin: 'https://vantage-osint.vercel.app' };

    const publicScore = await gateway(new Request(
      'https://vantage-osint.vercel.app/api/resilience/v1/get-resilience-score?countryCode=UA',
      { headers },
    ));
    const unsafe = await gateway(new Request(
      'https://vantage-osint.vercel.app/api/market/v1/analyze-stock?symbol=AAPL',
      { headers },
    ));

    assert.equal(publicScore.status, 200);
    assert.equal(scoreCalls, 1);
    assert.equal(unsafe.status, 401);
    assert.equal(unsafeCalls, 0, 'unsafe handler must remain behind the canonical auth gate');
  });
});
