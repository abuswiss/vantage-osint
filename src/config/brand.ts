// Central brand identity — PLACEHOLDER pending the real product name.
//
// Every user-visible product-name string must come from here (or from
// VARIANT_META, which derives from here) so the final rename is a single-file
// change plus a sweep for the literals listed below.
//
// Deliberately NOT yet rebranded (deferred to the real-name pass):
//  - Domains/URLs (worldmonitor.app) in meta tags, JSON-LD, docs, API config
//  - localStorage key prefixes ('worldmonitor-*') — renaming breaks stored
//    user state; needs a migration when the real name lands
//  - package.json name, proto/server namespace paths, blog-site and
//    public/*.md marketing content
export const BRAND = {
  /** Product display name (header, titles, PWA). */
  name: 'Vantage',
  /** Short name for tight UI spots and the PWA short_name. */
  shortName: 'Vantage',
  /** One-line positioning used in titles and meta descriptions. */
  tagline: 'Real-Time Global Intelligence Dashboard',
} as const;
