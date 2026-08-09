/**
 * Country-brief signal coverage model.
 *
 * The deep-dive brief aggregates independent client caches (news, protests,
 * military, outages, quakes, CII conflict ingest). Each of those can be
 * "loaded and empty" (a healthy source that is quiet) or "never loaded /
 * unavailable" — and the two must never render the same way: a missing feed
 * shown as 0 reads as calm. This pure module derives, from cache presence
 * flags, which domains are unavailable and which timeline lanes must say
 * "coverage unavailable" instead of "no events in 7 days".
 *
 * Single source of truth for chips, severity note, timeline empty-lanes, and
 * the narrative context snapshot (country-intel passes the same object to
 * all four surfaces).
 */

export type CountrySignalDomain =
  | 'news'
  | 'protests'
  | 'military'
  | 'outages'
  | 'earthquakes'
  | 'conflict';

export type CountryTimelineLane = 'protest' | 'conflict' | 'natural' | 'military';

export interface CountrySignalSourcePresence {
  /** Any news items loaded at all (feed pipeline reachable). */
  news: boolean;
  /** intelligenceCache.protests fetched (empty array still counts as present). */
  protests: boolean;
  /** intelligenceCache.military fetched. */
  military: boolean;
  /** intelligenceCache.outages fetched. */
  outages: boolean;
  /** intelligenceCache.earthquakes fetched. */
  earthquakes: boolean;
  /** CII ingest has run for at least one country (conflict/displacement source). */
  cii: boolean;
}

export interface CountryBriefCoverage {
  unavailableDomains: CountrySignalDomain[];
  timelineUnavailableLanes: CountryTimelineLane[];
  hasGaps: boolean;
}

const DOMAIN_ORDER: CountrySignalDomain[] = [
  'news', 'protests', 'military', 'outages', 'earthquakes', 'conflict',
];

const DOMAIN_PRESENCE: Record<CountrySignalDomain, keyof CountrySignalSourcePresence> = {
  news: 'news',
  protests: 'protests',
  military: 'military',
  outages: 'outages',
  earthquakes: 'earthquakes',
  conflict: 'cii',
};

const LANE_DOMAIN: Record<CountryTimelineLane, CountrySignalDomain> = {
  protest: 'protests',
  conflict: 'conflict',
  natural: 'earthquakes',
  military: 'military',
};

export function buildCountryBriefCoverage(presence: CountrySignalSourcePresence): CountryBriefCoverage {
  const unavailableDomains = DOMAIN_ORDER.filter(
    (domain) => !presence[DOMAIN_PRESENCE[domain]],
  );
  const unavailableSet = new Set(unavailableDomains);
  const timelineUnavailableLanes = (Object.keys(LANE_DOMAIN) as CountryTimelineLane[])
    .filter((lane) => unavailableSet.has(LANE_DOMAIN[lane]));
  return {
    unavailableDomains,
    timelineUnavailableLanes,
    hasGaps: unavailableDomains.length > 0,
  };
}
