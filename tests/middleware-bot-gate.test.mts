// Regression tests for middleware.ts's bot-UA gate.
//
// Pins the contract around the `/api/brief/carousel/` carve-out
// shipped in PR #3196: social-platform image fetchers
// (Slack/Telegram/Discord/LinkedIn/etc.) must be able to download
// the carousel PNGs even though their UAs contain "bot" and thus
// match BOT_UA, while the generic bot gate must still 403 plain
// scrapers on every other API path.
//
// Without this test the allowlist is the kind of policy that
// silently regresses on future middleware edits — Telegram's
// sendMediaGroup failure mode ("WEBPAGE_CURL_FAILED") does not
// surface as a CI failure anywhere else.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import middleware from '../middleware';

const TELEGRAM_BOT_UA = 'TelegramBot (like TwitterBot)';
const SLACKBOT_UA = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';
const DISCORDBOT_UA = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const LINKEDINBOT_UA = 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)';
const GENERIC_CURL_UA = 'curl/8.1.2';
const GENERIC_SCRAPER_UA = 'Mozilla/5.0 (compatible; SomeRandomBot/1.2)';
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Slot format: YYYY-MM-DD-HHMM — per compose run, matches the
// carousel route's ISSUE_DATE_RE and the signer's slot regex.
const CAROUSEL_PATH = '/api/brief/carousel/user_abc/2026-04-19-0800/0';
// Bare YYYY-MM-DD (the pre-slot shape) must no longer match, so digest
// links that predate the slot rollout naturally fall into the bot gate
// instead of silently leaking the allowlist.
const LEGACY_DATE_ONLY_CAROUSEL_PATH = '/api/brief/carousel/user_abc/2026-04-19/0';
const OTHER_API_PATH = '/api/notifications';
const MALFORMED_CAROUSEL_PATH = '/api/brief/carousel/admin/dashboard';

function call(pathOrUrl: string, ua: string, headers: Record<string, string> = {}): Response | void {
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `https://www.worldmonitor.app${pathOrUrl}`;
  const req = new Request(url, {
    headers: {
      ...(ua ? { 'user-agent': ua } : {}),
      ...headers,
    },
  });
  return middleware(req) as Response | void;
}

describe('middleware bot gate / keyed API clients', () => {
  const KEYED_API_PATH = '/api/forecast/v1/get-forecast-scorecard';
  const USER_API_KEY = `wm_${'a'.repeat(40)}`;
  const ENTERPRISE_API_KEY = `wm_${'b'.repeat(48)}`;

  it('passes a 40-hex user API key through when curl would otherwise be blocked', () => {
    const res = call(KEYED_API_PATH, GENERIC_CURL_UA, { 'x-worldmonitor-key': USER_API_KEY });
    assert.equal(res, undefined, 'the gateway, not the UA gate, must validate a well-shaped user key');
  });

  it('passes a 48-hex enterprise API key through when curl would otherwise be blocked', () => {
    const res = call(KEYED_API_PATH, GENERIC_CURL_UA, { 'x-worldmonitor-key': ENTERPRISE_API_KEY });
    assert.equal(res, undefined, 'the gateway, not the UA gate, must validate a well-shaped enterprise key');
  });

  it('still blocks malformed and overlong wm_ keys with a curl UA', () => {
    for (const apiKey of [`wm_${'c'.repeat(39)}`, `wm_${'d'.repeat(65)}`, 'wm_not-hex']) {
      const res = call(KEYED_API_PATH, GENERIC_CURL_UA, { 'x-worldmonitor-key': apiKey });
      assert.ok(res instanceof Response, `${apiKey} must not bypass the UA gate`);
      assert.equal(res.status, 403);
    }
  });
});

describe('middleware bot gate / carousel allowlist', () => {
  it('passes TelegramBot through on the carousel route (the PR #3196 fix)', () => {
    const res = call(CAROUSEL_PATH, TELEGRAM_BOT_UA);
    assert.equal(res, undefined, 'Telegram must be able to fetch carousel images');
  });

  it('passes Slackbot through on the carousel route', () => {
    const res = call(CAROUSEL_PATH, SLACKBOT_UA);
    assert.equal(res, undefined);
  });

  it('passes Discordbot through on the carousel route', () => {
    const res = call(CAROUSEL_PATH, DISCORDBOT_UA);
    assert.equal(res, undefined);
  });

  it('passes LinkedInBot through on the carousel route', () => {
    const res = call(CAROUSEL_PATH, LINKEDINBOT_UA);
    assert.equal(res, undefined);
  });

  it('still 403s curl on the carousel route (bot gate protects from non-social UAs)', () => {
    const res = call(CAROUSEL_PATH, GENERIC_CURL_UA);
    assert.ok(res instanceof Response, 'should return a Response, not pass through');
    assert.equal(res.status, 403);
  });

  it('still 403s a generic "bot" UA on the carousel route', () => {
    const res = call(CAROUSEL_PATH, GENERIC_SCRAPER_UA);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });

  it('still 403s TelegramBot on non-carousel API routes (allowlist is scoped, not global)', () => {
    const res = call(OTHER_API_PATH, TELEGRAM_BOT_UA);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });

  it('still 403s TelegramBot on malformed carousel paths (regex enforces route shape)', () => {
    const res = call(MALFORMED_CAROUSEL_PATH, TELEGRAM_BOT_UA);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });

  it('still 403s missing UA on the carousel route (short-UA guard)', () => {
    const res = call(CAROUSEL_PATH, '');
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });

  it('passes normal browsers through on the carousel route', () => {
    const res = call(CAROUSEL_PATH, CHROME_UA);
    assert.equal(res, undefined);
  });

  it('passes normal browsers through on any API route', () => {
    const res = call(OTHER_API_PATH, CHROME_UA);
    assert.equal(res, undefined);
  });

  it('does not accept page 3+ on the carousel route (pageFromIndex only has 0/1/2)', () => {
    const res = call('/api/brief/carousel/user_abc/2026-04-19-0800/3', TELEGRAM_BOT_UA);
    assert.ok(res instanceof Response, 'out-of-range page must hit the bot gate');
    assert.equal(res.status, 403);
  });

  it('does not accept non-slot segments on the carousel route', () => {
    const res = call('/api/brief/carousel/user_abc/today/0', TELEGRAM_BOT_UA);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });

  it('does not accept the pre-slot YYYY-MM-DD shape (slot rollout parity)', () => {
    // Once the composer moves to slot URLs, legacy date-only paths
    // should NOT leak the social allowlist — they correspond to
    // expired pre-rollout links whose Redis keys no longer exist.
    const res = call(LEGACY_DATE_ONLY_CAROUSEL_PATH, TELEGRAM_BOT_UA);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });
});

// ── PUBLIC_API_PATHS allowlist (secret-authed internal endpoints) ────────────
// The middleware's "no UA or suspiciously short" 403 guard (middleware.ts:
// ~L183) blocks Node/undici default-UA callers. Internal endpoints that carry
// their own Bearer-auth must be in PUBLIC_API_PATHS to bypass the gate.
//
// History:
//   - /api/seed-contract-probe hit this 2026-04-15 (UptimeRobot + ops curl).
//   - /api/internal/brief-why-matters hit this 2026-04-21 immediately after
//     PR #3248 merge — every Railway cron call returned 403 and silently
//     fell back to legacy Gemini. No functional breakage (3-layer fallback
//     absorbed it) but the new feature never ran in prod.
//
// These tests pin the allowlist so a future middleware refactor (e.g. the
// BOT_UA regex being narrowed, or PUBLIC_API_PATHS being reorganized) can't
// silently drop an entry.

describe('middleware PUBLIC_API_PATHS — secret-authed internal endpoints bypass UA gate', () => {
  // UAs that would normally 403 on any other API route.
  const EMPTY_UA = '';
  const UNDICI_UA = 'undici';          // Too short (<10 chars) — triggers short-UA 403.
  const CURL_UA = GENERIC_CURL_UA;     // Matches curl/ in BOT_UA regex.

  const TRIGGERS = [
    { label: 'empty UA (middleware short-UA gate)', ua: EMPTY_UA },
    { label: 'short UA (Node undici default-ish)', ua: UNDICI_UA },
    { label: 'curl UA (BOT_UA regex hit)', ua: CURL_UA },
  ];

  const ALLOWED_PATHS = [
    '/api/version',
    '/api/health',
    '/api/seed-contract-probe',
    '/api/internal/brief-why-matters',
    '/api/llms.txt',
    '/api/product-catalog',
    '/api/vantage-refresh',
  ];

  for (const path of ALLOWED_PATHS) {
    for (const { label, ua } of TRIGGERS) {
      it(`${path} bypasses the UA gate (${label})`, () => {
        const res = call(path, ua);
        assert.equal(res, undefined, `${path} must pass through the middleware (no 403); its own auth gate handles access`);
      });
    }
  }

  // Negative case: a sibling path that is NOT in the allowlist must still 403
  // under EACH of the 3 triggers. This catches a future refactor that moves
  // the PUBLIC_API_PATHS check later in the chain (e.g. behind a broadened
  // prefix-match) and might let one of the trigger UAs slip through on a
  // sibling path without this suite failing. Pin all three guard paths.
  const SIBLING_PATHS = [
    '/api/internal/brief-why-matters-v2',     // near-miss suffix
    '/api/internal/',                          // directory only
    '/api/internal/other',                     // different leaf
    '/api/vantage-refresh-extra',              // cron allowlist must be exact
  ];

  for (const path of SIBLING_PATHS) {
    for (const { label, ua } of TRIGGERS) {
      it(`${path} does NOT bypass the UA gate — ${label}`, () => {
        const res = call(path, ua);
        assert.ok(res instanceof Response, `${path} must still hit the 403 guard under ${label}`);
        assert.equal(res.status, 403);
      });
    }
  }
});

// ── /api/llms.txt agent-discovery bypass ─────────────────────────────────────
// The section-level llms.txt for the developer/API surface lives at
// public/api/llms.txt, so it is served under the /api/* namespace where the
// middleware's BOT_UA gate 403s crawlers. AI crawlers are the entire audience
// for an llms.txt, so the bypass must let them through — otherwise the file is
// published but unreadable by the agents it exists to serve.

describe('middleware /api/llms.txt — AI crawlers reach the agent-discovery file', () => {
  const CRAWLER_UAS = [
    { label: 'ClaudeBot', ua: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)' },
    { label: 'GPTBot', ua: 'Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)' },
    { label: 'PerplexityBot', ua: 'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)' },
    { label: 'CCBot', ua: 'CCBot/2.0 (https://commoncrawl.org/faq/)' },
    { label: 'generic scraper', ua: GENERIC_SCRAPER_UA },
    { label: 'empty UA', ua: '' },
  ];

  for (const { label, ua } of CRAWLER_UAS) {
    it(`passes ${label} through to /api/llms.txt`, () => {
      const res = call('/api/llms.txt', ua);
      assert.equal(res, undefined, '/api/llms.txt must pass through the bot gate for AI crawlers');
    });
  }

  it('still 403s a crawler on a sibling /api path (bypass is exact, not a prefix)', () => {
    const res = call('/api/llms', 'CCBot/2.0 (https://commoncrawl.org/faq/)');
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });
});

// ── /api/product-catalog public-pricing bypass ──────────────────────────────
// The keyless read-only pricing catalog is advertised as service-meta in
// /.well-known/api-catalog; agents evaluating the product are its primary
// audience. An agent-journey run (#4854) hit the UA gate here and concluded
// the endpoint did not exist. DELETE (cache purge) stays protected by the
// endpoint's own auth — the middleware bypass only skips UA filtering.

describe('middleware /api/product-catalog — agents reach the public pricing catalog', () => {
  const CRAWLER_UAS = [
    { label: 'ClaudeBot', ua: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)' },
    { label: 'GPTBot', ua: 'Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)' },
    { label: 'python-requests', ua: 'python-requests/2.31' },
    { label: 'empty UA', ua: '' },
  ];

  for (const { label, ua } of CRAWLER_UAS) {
    it(`passes ${label} through to /api/product-catalog`, () => {
      const res = call('/api/product-catalog', ua);
      assert.equal(res, undefined, '/api/product-catalog must pass through the bot gate; it is a public discovery surface');
    });
  }

  it('still 403s a crawler on a sibling /api path (bypass is exact, not a prefix)', () => {
    const res = call('/api/product', 'CCBot/2.0 (https://commoncrawl.org/faq/)');
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });
});

// ── /mcp single-variant contract ─────────────────────────────────────────────
// The variant-subdomain /mcp → apex canonicalization redirect was removed with
// the variant subdomains themselves. /mcp must pass through the middleware
// untouched on the remaining hosts so the /api/mcp rewrite handles it.

describe('middleware /mcp — no variant redirect machinery remains', () => {
  it('does NOT redirect GET /mcp from apex or www', () => {
    assert.equal(call('https://worldmonitor.app/mcp', CHROME_UA), undefined);
    assert.equal(call('https://www.worldmonitor.app/mcp', CHROME_UA), undefined);
  });

  it('does NOT redirect POST /mcp (MCP handshake falls through to the /api/mcp rewrite)', () => {
    const req = new Request('https://worldmonitor.app/mcp', {
      method: 'POST',
      headers: { 'user-agent': CHROME_UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const res = middleware(req) as Response | void;
    assert.equal(res, undefined, 'POST /mcp must fall through to the /api/mcp rewrite');
  });
});

// ── legacy dashboard state on the root URL ───────────────────────────────────
// The apex `/` is rewritten to the marketing welcome page in vercel.json, so
// any root URL that actually carries dashboard state must 308 to /dashboard
// first. That includes the country deep links every prebuilt SEO page emits
// (/?country=XX&expanded=1) — before those keys were added, all 197 country
// pages linked visitors to the welcome page instead of the country brief.

describe('middleware root URL — dashboard state redirects to /dashboard', () => {
  const DASHBOARD_STATE_QUERIES = [
    '?lat=48.3&lon=31.1&zoom=4',
    '?country=UA&expanded=1',
    '?country=UA',
    '?chokepoint=bab_el_mandeb',
    '?focus=news:abc123',
    '?c=IR',
    '?classic=1',
  ];

  for (const query of DASHBOARD_STATE_QUERIES) {
    it(`308s / ${query} to /dashboard preserving the query`, () => {
      const res = call(`https://www.worldmonitor.app/${query}`, CHROME_UA);
      assert.ok(res instanceof Response, `expected a redirect for ${query}`);
      assert.equal(res.status, 308);
      const location = new URL(res.headers.get('location') ?? '');
      assert.equal(location.pathname, '/dashboard');
      assert.equal(location.search, query);
    });
  }

  it('leaves a bare root URL alone (welcome rewrite handles it)', () => {
    assert.equal(call('https://www.worldmonitor.app/', CHROME_UA), undefined);
  });

  it('leaves unrelated root queries alone (e.g. utm-only)', () => {
    assert.equal(call('https://www.worldmonitor.app/?utm_source=newsletter', CHROME_UA), undefined);
  });
});

// ── retired variant subdomains ───────────────────────────────────────────────
// tech/finance/commodity/happy/energy.worldmonitor.app were retired with the
// single-variant strip. Their roots previously served the full dashboard under
// the dead host; now they canonicalize to www.worldmonitor.app/dashboard with
// the query preserved so old bookmarks and deep links keep working.

describe('middleware retired variant hosts — root canonicalizes to /dashboard', () => {
  for (const host of ['tech', 'finance', 'commodity', 'happy', 'energy']) {
    it(`308s https://${host}.worldmonitor.app/ to the canonical dashboard`, () => {
      const res = call(`https://${host}.worldmonitor.app/?country=UA`, CHROME_UA);
      assert.ok(res instanceof Response, `expected a redirect for ${host}`);
      assert.equal(res.status, 308);
      const location = new URL(res.headers.get('location') ?? '');
      assert.equal(location.hostname, 'www.worldmonitor.app');
      assert.equal(location.pathname, '/dashboard');
      assert.equal(location.search, '?country=UA');
    });
  }

  it('does not touch the apex or www roots', () => {
    assert.equal(call('https://worldmonitor.app/', CHROME_UA), undefined);
    assert.equal(call('https://www.worldmonitor.app/', CHROME_UA), undefined);
  });
});

// Deep paths on retired hosts must ALSO canonicalize (path + query preserved).
// The welcome/pro surfaces and old share links emitted /dashboard deep links
// on variant hosts for years — root-only coverage silently served the full
// dashboard under a dead hostname for all of them.
describe('middleware retired variant hosts — deep paths canonicalize with path preserved', () => {
  const DEEP_PATHS = [
    '/dashboard',
    '/dashboard?country=UA&expanded=1',
    '/countries/ukraine/',
    '/country/israel',
    '/embed',
  ];

  for (const pathAndQuery of DEEP_PATHS) {
    it(`308s https://tech.worldmonitor.app${pathAndQuery} to www with path preserved`, () => {
      const res = call(`https://tech.worldmonitor.app${pathAndQuery}`, CHROME_UA);
      assert.ok(res instanceof Response, `expected a redirect for ${pathAndQuery}`);
      assert.equal(res.status, 308);
      const source = new URL(`https://tech.worldmonitor.app${pathAndQuery}`);
      const location = new URL(res.headers.get('location') ?? '');
      assert.equal(location.hostname, 'www.worldmonitor.app');
      assert.equal(location.pathname, source.pathname);
      assert.equal(location.search, source.search);
    });
  }

  it('leaves retired-host /api/* requests to the normal API gate (no redirect)', () => {
    // API clients configured against an old host keep working; the bot gate
    // still applies as on any host.
    assert.equal(call('https://tech.worldmonitor.app/api/health', CHROME_UA), undefined);
  });

  it('leaves canonical-host deep paths alone', () => {
    assert.equal(call('https://www.worldmonitor.app/dashboard?country=UA', CHROME_UA), undefined);
    assert.equal(call('https://www.worldmonitor.app/countries/ukraine/', CHROME_UA), undefined);
  });
});
