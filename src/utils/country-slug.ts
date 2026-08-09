/**
 * Resolve a /country/:slug deep-link segment to an ISO2 country code.
 *
 * Slugs on the prebuilt SEO pages (public/countries/<slug>/) come from
 * scripts/build-crawlable-corpus.mjs slugify() over the raw country name, so
 * this mirrors that transform over shared/country-names.json (the same
 * lowercase-name -> ISO2 registry the corpus builder reverse-maps). Loaded
 * lazily from App deep-link handling — keep this module free of other app
 * imports so the country-names payload stays out of the entry chunk.
 */
import COUNTRY_NAMES_RAW from '../../shared/country-names.json';

const COUNTRY_NAMES = COUNTRY_NAMES_RAW as Record<string, string>;

// Port of scripts/build-crawlable-corpus.mjs slugify() — keep in sync.
export function slugifyCountryName(value: string): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .toLowerCase();
}

let slugToCode: Map<string, string> | null = null;
let knownCodes: Set<string> | null = null;

function buildIndex(): { slugs: Map<string, string>; codes: Set<string> } {
  if (!slugToCode || !knownCodes) {
    slugToCode = new Map();
    knownCodes = new Set();
    for (const [name, code] of Object.entries(COUNTRY_NAMES)) {
      knownCodes.add(code);
      const slug = slugifyCountryName(name);
      if (slug && !slugToCode.has(slug)) slugToCode.set(slug, code);
    }
  }
  return { slugs: slugToCode, codes: knownCodes };
}

export function resolveCountrySlug(rawSlug: string): string | null {
  let decoded = rawSlug;
  try {
    decoded = decodeURIComponent(rawSlug);
  } catch { /* keep raw value */ }
  const slug = slugifyCountryName(decoded);
  if (!slug) return null;

  const { slugs, codes } = buildIndex();

  // Bare ISO2 code (/country/ua) — accept as a compatibility spelling.
  if (slug.length === 2 && codes.has(slug.toUpperCase())) return slug.toUpperCase();

  const direct = slugs.get(slug);
  if (direct) return direct;

  // uniqueSlug() in the corpus builder de-duplicates colliding names by
  // appending the lowercase ISO2 code (e.g. congo-cd). Trust the suffix when
  // it names a known country.
  const suffix = slug.match(/-([a-z]{2})$/)?.[1];
  if (suffix) {
    const code = suffix.toUpperCase();
    if (codes.has(code)) return code;
  }

  return null;
}
