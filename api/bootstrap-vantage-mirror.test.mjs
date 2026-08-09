import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';

import handler, { __testing__ } from './bootstrap.js';

const originalVantageMode = process.env.VANTAGE_PUBLIC_MODE;
const originalViteVantageMode = process.env.VITE_VANTAGE_PUBLIC_MODE;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore('VANTAGE_PUBLIC_MODE', originalVantageMode);
  restore('VITE_VANTAGE_PUBLIC_MODE', originalViteVantageMode);
  restore('UPSTASH_REDIS_REST_URL', originalRedisUrl);
  restore('UPSTASH_REDIS_REST_TOKEN', originalRedisToken);
  __testing__.resetCanonicalPublicBootstrapMirrorForTests();
});

function enableVantageMirror() {
  process.env.VANTAGE_PUBLIC_MODE = 'true';
  delete process.env.VITE_VANTAGE_PUBLIC_MODE;
}

function vantageRequest(query, headers = {}) {
  return new Request(`https://vantage-osint.vercel.app/api/bootstrap?${query}`, {
    method: 'GET',
    headers: {
      Origin: 'https://vantage-osint.vercel.app',
      ...headers,
    },
  });
}

test('Vantage mirrors an exact public tier through the fixed canonical origin without forwarding credentials', async () => {
  enableVantageMirror();
  const calls = [];
  const upstreamPayload = { data: { marketQuotes: { symbol: 'SPY', price: 640 } }, missing: [] };
  __testing__.setCanonicalPublicBootstrapMirrorFetchForTests(async (input, init) => {
    calls.push({ input, init });
    return Response.json(upstreamPayload);
  });

  const response = await handler(vantageRequest('tier=fast&public=1', {
    Authorization: 'Bearer must-not-forward',
    Cookie: 'wm-session=must-not-forward',
    'X-WorldMonitor-Key': 'must-not-forward',
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), upstreamPayload);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://api.worldmonitor.app/api/bootstrap?tier=fast&public=1');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.redirect, 'error');
  const upstreamHeaders = new Headers(calls[0].init.headers);
  assert.deepEqual([...upstreamHeaders.keys()].sort(), ['accept', 'user-agent']);
  assert.equal(upstreamHeaders.get('accept'), 'application/json');
  assert.match(upstreamHeaders.get('user-agent') || '', /Mozilla\/5\.0.*Chrome\//);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('cache-control') || '', /max-age=60/);
  assert.match(response.headers.get('cdn-cache-control') || '', /s-maxage=600/);
});

test('Vantage mirrors only the audited single-key on-demand shape with the bounded default cache profile', async () => {
  enableVantageMirror();
  const calls = [];
  const upstreamPayload = { data: { jodiOil: { countries: [] } }, missing: [] };
  __testing__.setCanonicalPublicBootstrapMirrorFetchForTests(async (input) => {
    calls.push(input);
    return Response.json(upstreamPayload);
  });

  const response = await handler(vantageRequest('keys=jodiOil&public=1'));

  assert.equal(response.status, 200);
  assert.equal(calls[0], 'https://api.worldmonitor.app/api/bootstrap?keys=jodiOil&public=1');
  assert.deepEqual(await response.json(), upstreamPayload);
  assert.match(response.headers.get('cdn-cache-control') || '', /s-maxage=600/);
  assert.doesNotMatch(response.headers.get('cdn-cache-control') || '', /s-maxage=7200/);
});

test('Vantage preserves the canonical slow-tier cache profile', async () => {
  enableVantageMirror();
  __testing__.setCanonicalPublicBootstrapMirrorFetchForTests(async () =>
    Response.json({ data: { countryInstability: [] }, missing: [] }));

  const response = await handler(vantageRequest('tier=slow&public=1'));

  assert.equal(response.status, 200);
  assert.match(response.headers.get('cdn-cache-control') || '', /s-maxage=7200/);
});

test('Vantage mirrors the exact public weather shape with the fast cache profile', async () => {
  enableVantageMirror();
  const calls = [];
  const upstreamPayload = { data: { weatherAlerts: [] }, missing: [] };
  __testing__.setCanonicalPublicBootstrapMirrorFetchForTests(async (input) => {
    calls.push(input);
    return Response.json(upstreamPayload);
  });

  const response = await handler(vantageRequest('keys=weatherAlerts&public=1'));

  assert.equal(response.status, 200);
  assert.equal(calls[0], 'https://api.worldmonitor.app/api/bootstrap?keys=weatherAlerts&public=1');
  assert.deepEqual(await response.json(), upstreamPayload);
  assert.match(response.headers.get('cdn-cache-control') || '', /s-maxage=600/);
});

test('canonical mirror failures and malformed payloads fail closed without poisoning the shared cache', async () => {
  enableVantageMirror();
  for (const upstream of [
    async () => new Response('upstream unavailable', { status: 500 }),
    async () => Response.json({ data: {}, missing: 'not-an-array' }),
    async () => { throw new TypeError('fetch failed'); },
  ]) {
    __testing__.setCanonicalPublicBootstrapMirrorFetchForTests(upstream);
    const response = await handler(vantageRequest('tier=slow&public=1'));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Bootstrap service temporarily unavailable' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('cdn-cache-control'), null);
    assert.equal(response.headers.get('retry-after'), '5');
  }
});

test('Vantage public mode does not widen the mirror beyond exact audited URL shapes', async () => {
  enableVantageMirror();
  let calls = 0;
  __testing__.setCanonicalPublicBootstrapMirrorFetchForTests(async () => {
    calls += 1;
    return Response.json({ data: {}, missing: [] });
  });

  for (const query of [
    'tier=fast&public=1&extra=1',
    'keys=jodiOil,imfMacro&public=1',
    'keys=marketQuotes&public=1',
  ]) {
    const response = await handler(vantageRequest(query));
    assert.equal(response.status, 401, query);
  }
  assert.equal(calls, 0);
});

test('the Vantage flag off leaves the local canonical bootstrap path untouched', async () => {
  process.env.VANTAGE_PUBLIC_MODE = 'false';
  process.env.VITE_VANTAGE_PUBLIC_MODE = 'true';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  let calls = 0;
  __testing__.setCanonicalPublicBootstrapMirrorFetchForTests(async () => {
    calls += 1;
    return Response.json({ data: {}, missing: [] });
  });

  const response = await handler(vantageRequest('tier=fast&public=1'));

  assert.equal(calls, 0);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
