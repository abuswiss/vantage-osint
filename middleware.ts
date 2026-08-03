const BOT_UA =
  /bot|crawl|spider|slurp|archiver|wget|curl\/|python-requests|scrapy|httpclient|go-http|java\/|libwww|perl|ruby|php\/|ahrefsbot|semrushbot|mj12bot|dotbot|baiduspider|yandexbot|sogou|bytespider|petalbot|gptbot|claudebot|ccbot/i;

const SOCIAL_PREVIEW_UA =
  /twitterbot|facebookexternalhit|linkedinbot|slackbot|telegrambot|whatsapp|discordbot|redditbot/i;

const SOCIAL_PREVIEW_PATHS = new Set(['/api/story', '/api/og-story']);
const LEGACY_DASHBOARD_ROOT_QUERY_KEYS = ['lat', 'lon', 'zoom', 'view', 'timeRange', 'layers'] as const;

// Paths that bypass bot/script UA filtering below. Each must carry its own
// auth (API key, shared secret, or intentionally-public semantics) because
// this list disables the middleware's generic bot gate.
// - /api/version, /api/health: intentionally public, monitoring-friendly.
// - /api/seed-contract-probe: requires RELAY_SHARED_SECRET header; called by
//   UptimeRobot + ops curl. Was blocked by the curl/bot UA regex before this
//   exception landed (Vercel log 2026-04-15: "Middleware 403 Forbidden" on
//   /api/seed-contract-probe).
// - /api/internal/brief-why-matters: requires RELAY_SHARED_SECRET Bearer
//   (subtle-crypto HMAC timing-safe compare in server/_shared/internal-auth.ts).
//   Called from the Railway digest-notifications cron whose fetch() uses the
//   Node undici default UA, which is short enough to trip the "no UA or
//   suspiciously short" 403 below (Railway log 2026-04-21 post-#3248 merge:
//   every cron call returned 403 and silently fell back to legacy Gemini).
// - /api/llms.txt: static, intentionally-public agent-discovery document
//   (the section-level llms.txt for the developer/API surface, served from
//   public/api/llms.txt). It MUST bypass the bot gate — AI crawlers (ClaudeBot,
//   GPTBot, PerplexityBot, CCBot, …) are the entire audience for an llms.txt,
//   yet every one of those UAs matches BOT_UA and would otherwise 403.
// - /api/product-catalog: public read-only pricing catalog (Redis-cached,
//   keyless, advertised as service-meta in /.well-known/api-catalog). Agents
//   evaluating the product are a primary audience; an agent-journey run (#4854)
//   got 403 here and concluded the endpoint didn't exist.
const PUBLIC_API_PATHS = new Set([
  '/api/version',
  '/api/health',
  '/api/seed-contract-probe',
  '/api/internal/brief-why-matters',
  '/api/llms.txt',
  '/api/product-catalog',
]);

const SOCIAL_IMAGE_UA =
  /Slack-ImgProxy|Slackbot|twitterbot|facebookexternalhit|linkedinbot|telegrambot|whatsapp|discordbot|redditbot/i;

// Must match the exact route shape enforced by
// api/brief/carousel/[userId]/[issueDate]/[page].ts:
//   /api/brief/carousel/<userId>/YYYY-MM-DD-HHMM/<0|1|2>
// The issueDate segment is a per-run slot (date + HHMM in the user's
// tz) so same-day digests produce distinct carousel URLs.
// pageFromIndex() in brief-carousel-render.ts accepts only 0/1/2, so
// the trailing segment is tightly bounded.
const BRIEF_CAROUSEL_PATH_RE =
  /^\/api\/brief\/carousel\/[^/]+\/\d{4}-\d{2}-\d{2}-\d{4}\/[0-2]\/?$/;

function hasLegacyDashboardRootState(searchParams: URLSearchParams): boolean {
  return LEGACY_DASHBOARD_ROOT_QUERY_KEYS.some((key) => searchParams.has(key));
}

export default function middleware(request: Request) {
  const url = new URL(request.url);
  const ua = request.headers.get('user-agent') ?? '';
  const path = url.pathname;

  if (path === '/' && hasLegacyDashboardRootState(url.searchParams)) {
    const dashboardUrl = new URL(request.url);
    dashboardUrl.pathname = '/dashboard';
    return Response.redirect(dashboardUrl.toString(), 308);
  }

  // Only apply bot filtering to /api/* paths.
  //
  // /favico/* is deliberately NOT gated: it serves public static brand
  // assets (favicons, app icons, the email logo) that must be retrievable
  // by ANY client — browsers, email clients and their image proxies, link
  // unfurlers, preview scrapers. Bot-gating it broke the logo in
  // transactional emails when a client/proxy fetched with a script-like UA
  // (the same reason Cloudflare's "Block API Bots" rule was narrowed to
  // /api/* only). /favico/* is also removed from the matcher below so the
  // middleware never runs on it.
  if (!path.startsWith('/api/')) {
    return;
  }

  // Allow social preview/image bots on OG image assets.
  //
  // Image-returning API routes that don't end in `.png` also need
  // an explicit carve-out — otherwise server-side fetches from
  // Slack / Telegram / Discord / LinkedIn / WhatsApp / Facebook /
  // Twitter / Reddit all trip the BOT_UA gate below. Telegram
  // surfaces it as error 400 "WEBPAGE_CURL_FAILED" on sendMediaGroup;
  // the others silently drop the preview image.
  //
  // Only the brief carousel route shape is allowlisted — a strict
  // regex (same shape enforced by the handler) prevents a future
  // /api/brief/carousel/admin or similar sibling from accidentally
  // inheriting this bypass. HMAC token in the URL is the real auth;
  // this allowlist is defence-in-depth for any well-shaped request
  // whose UA happens to be in SOCIAL_IMAGE_UA.
  if (
    path.endsWith('.png') ||
    BRIEF_CAROUSEL_PATH_RE.test(path)
  ) {
    if (SOCIAL_IMAGE_UA.test(ua)) {
      return;
    }
  }

  // Allow social preview bots on exact OG routes only
  if (SOCIAL_PREVIEW_UA.test(ua) && SOCIAL_PREVIEW_PATHS.has(path)) {
    return;
  }

  // Public endpoints bypass all bot filtering
  if (PUBLIC_API_PATHS.has(path)) {
    return;
  }

  // Authenticated Pro API clients bypass UA filtering. This is a cheap
  // edge heuristic, not auth — real validation (SHA-256 hash vs Convex
  // userApiKeys + entitlement) happens in server/gateway.ts. To keep the
  // bot-UA shield meaningful, require the `wm_` prefix plus 40–64 lowercase
  // hex chars. User keys are 40 hex chars; enterprise keys may be longer.
  // A random scraper would still have to guess this format, and spoofed-but-
  // well-shaped keys still 401 at the gateway.
  const WM_KEY_SHAPE = /^wm_[a-f0-9]{40,64}$/;
  const apiKey =
    request.headers.get('x-worldmonitor-key') ??
    request.headers.get('x-api-key') ??
    '';
  if (WM_KEY_SHAPE.test(apiKey)) {
    return;
  }

  // Block bots from all API routes
  if (BOT_UA.test(ua)) {
    return new Response('{"error":"Forbidden"}', {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // No user-agent or suspiciously short — likely a script
  if (!ua || ua.length < 10) {
    return new Response('{"error":"Forbidden"}', {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export const config = {
  matcher: ['/', '/api/:path*'],
};
