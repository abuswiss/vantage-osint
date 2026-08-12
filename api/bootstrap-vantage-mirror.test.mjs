import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';

import { config as canonicalBootstrapConfig } from './bootstrap.js';
import runtimeHandler, {
  __testing__,
  config,
  handleVantageBootstrap as handler,
} from './vantage-bootstrap.js';
import {
  VANTAGE_BOOTSTRAP_PATH,
  classifyVantagePublicBootstrapUrl,
  rewriteVantagePublicBootstrapPath,
} from '../shared/vantage-public-bootstrap.js';

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
  __testing__.resetCanonicalPublicBootstrapFetchForTests();
});

function enableVantageMirror() {
  process.env.VANTAGE_PUBLIC_MODE = 'true';
  delete process.env.VITE_VANTAGE_PUBLIC_MODE;
}

function vantageRequest(query, headers = {}) {
  return new Request(`https://vantage-osint.vercel.app/api/vantage-bootstrap?${query}`, {
    method: 'GET',
    headers: {
      Origin: 'https://vantage-osint.vercel.app',
      ...headers,
    },
  });
}

test('Vantage has a dedicated Node transport while canonical bootstrap remains Edge', () => {
  assert.deepEqual(config, { maxDuration: 15 });
  assert.equal(config.runtime, undefined);
  assert.equal(runtimeHandler.fetch, handler);
  assert.deepEqual(canonicalBootstrapConfig, { runtime: 'edge' });
});

test('the client rewrite shares the facade exact-shape allowlist', () => {
  for (const path of [
    '/api/bootstrap?tier=fast&public=1',
    '/api/bootstrap?public=1&tier=slow',
    '/api/bootstrap?keys=jodiOil&public=1',
    '/api/bootstrap?keys=weatherAlerts&public=1',
  ]) {
    const rewritten = rewriteVantagePublicBootstrapPath(path, true);
    assert.equal(rewritten, path.replace('/api/bootstrap', VANTAGE_BOOTSTRAP_PATH));
    assert.ok(classifyVantagePublicBootstrapUrl(rewritten, { expectedPath: VANTAGE_BOOTSTRAP_PATH }));
    assert.equal(rewriteVantagePublicBootstrapPath(path, false), path);
  }

  for (const path of [
    '/api/bootstrap?tier=fast',
    '/api/bootstrap?tier=fast&public=1&extra=1',
    '/api/bootstrap?keys=jodiOil,imfMacro&public=1',
    '/api/bootstrap?keys=marketQuotes&public=1',
    '/api/bootstrap?keys=jodiOil&keys=imfMacro&public=1',
    '/api/bootstrap?keys=jodiOil&public=1&public=1',
    '/api/health',
  ]) {
    assert.equal(rewriteVantagePublicBootstrapPath(path, true), path);
  }
});

test('Vantage mirrors an exact public tier through the fixed canonical origin without forwarding credentials', async () => {
  enableVantageMirror();
  const calls = [];
  const upstreamPayload = { data: { marketQuotes: { symbol: 'SPY', price: 640 } }, missing: [] };
  __testing__.setCanonicalPublicBootstrapFetchForTests(async (input, init) => {
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
  __testing__.setCanonicalPublicBootstrapFetchForTests(async (input) => {
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
  __testing__.setCanonicalPublicBootstrapFetchForTests(async () =>
    Response.json({ data: { countryInstability: [] }, missing: [] }));

  const response = await handler(vantageRequest('tier=slow&public=1'));

  assert.equal(response.status, 200);
  assert.match(response.headers.get('cdn-cache-control') || '', /s-maxage=7200/);
});

test('Vantage mirrors the exact public weather shape with the fast cache profile', async () => {
  enableVantageMirror();
  const calls = [];
  const upstreamPayload = { data: { weatherAlerts: [] }, missing: [] };
  __testing__.setCanonicalPublicBootstrapFetchForTests(async (input) => {
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
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    for (const upstream of [
      async () => new Response('private upstream body', { status: 403 }),
      async () => new Response('private invalid json', { status: 200 }),
      async () => Response.json({ data: {}, missing: 'not-an-array' }),
      async () => { throw new TypeError('private fetch detail'); },
    ]) {
      __testing__.setCanonicalPublicBootstrapFetchForTests(upstream);
      const response = await handler(vantageRequest('tier=slow&public=1'));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'Bootstrap service temporarily unavailable' });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('cdn-cache-control'), null);
      assert.equal(response.headers.get('retry-after'), '5');
    }
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(
    warnings.map((warning) => warning[1]?.stage),
    ['upstream_status', 'invalid_json', 'invalid_payload', 'fetch_error'],
  );
  assert.equal(warnings[0]?.[1]?.upstreamStatus, 403);
  assert.equal(warnings.every((warning) => warning[1]?.runtime === 'node'), true);
  assert.doesNotMatch(JSON.stringify(warnings), /private|fetch detail|invalid json|upstream body/i);
});

test('Vantage public mode does not widen the mirror beyond exact audited URL shapes', async () => {
  enableVantageMirror();
  let calls = 0;
  __testing__.setCanonicalPublicBootstrapFetchForTests(async () => {
    calls += 1;
    return Response.json({ data: {}, missing: [] });
  });

  for (const query of [
    'tier=fast&public=1&extra=1',
    'keys=jodiOil,imfMacro&public=1',
    'keys=marketQuotes&public=1',
  ]) {
    const response = await handler(vantageRequest(query));
    assert.equal(response.status, 404, query);
  }
  assert.equal(calls, 0);
});

test('the Vantage flag off leaves the local canonical bootstrap path untouched', async () => {
  process.env.VANTAGE_PUBLIC_MODE = 'false';
  process.env.VITE_VANTAGE_PUBLIC_MODE = 'true';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  let calls = 0;
  __testing__.setCanonicalPublicBootstrapFetchForTests(async () => {
    calls += 1;
    return Response.json({ data: {}, missing: [] });
  });

  const response = await handler(vantageRequest('tier=fast&public=1'));

  assert.equal(calls, 0);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('the Vantage-only facade refuses canonical WorldMonitor hosts', async () => {
  enableVantageMirror();
  let calls = 0;
  __testing__.setCanonicalPublicBootstrapFetchForTests(async () => {
    calls += 1;
    return Response.json({ data: {}, missing: [] });
  });

  const response = await handler(new Request(
    'https://api.worldmonitor.app/api/vantage-bootstrap?tier=fast&public=1',
    { method: 'GET' },
  ));

  assert.equal(response.status, 404);
  assert.equal(calls, 0);
});
