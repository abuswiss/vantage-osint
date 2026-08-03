import type { Feed } from '@/types';
import { rssProxyUrl } from '@/utils';
import { mergeCanonicalFeeds } from './feed-resolution';
import {
  getSourceProvenanceState,
  type SourceProvenanceState,
} from '../../shared/source-provenance';

const rss = rssProxyUrl;
const railwayRss = rssProxyUrl;

// Source tier system — canonical definition lives in server/_shared/source-tiers.ts
// so server-side code can import it without pulling in client-only modules.
export { SOURCE_TIERS, getSourceTier } from '../../server/_shared/source-tiers';
export {
  SOURCE_PROPAGANDA_RISK,
  SOURCE_TYPES,
  UNREVIEWED_SOURCE_RISK,
  describePropagandaBadge,
  getSourcePropagandaRisk,
  getSourceProvenanceState,
  getSourceTierBadgeTitle,
  getSourceType,
  hasDeclaredPropagandaRisk,
  hasDeclaredSourceType,
  hasReviewedPropagandaRisk,
  hasReviewedSourceType,
  isStateAffiliatedSource,
} from '../../shared/source-provenance';
export type {
  PropagandaRisk,
  SourceProvenanceState,
  SourceRiskProfile,
  SourceType,
} from '../../shared/source-provenance';

let _sourcePanelMap: Map<string, string> | null = null;
export function getSourcePanelId(sourceName: string): string {
  if (!_sourcePanelMap) {
    _sourcePanelMap = new Map();
    // Seed with CANONICAL_FEEDS first so a source belonging to a cross-variant
    // custom panel still resolves to its real panel. The active-variant FEEDS
    // pass below then overwrites, so the active preset wins any collision.
    for (const [category, feeds] of Object.entries(CANONICAL_FEEDS)) {
      for (const feed of feeds) _sourcePanelMap.set(feed.name, category);
    }
    for (const [category, feeds] of Object.entries(FEEDS)) {
      for (const feed of feeds) _sourcePanelMap.set(feed.name, category);
    }
    for (const feed of INTEL_SOURCES) _sourcePanelMap.set(feed.name, 'intel');
  }
  return _sourcePanelMap.get(sourceName) ?? 'politics';
}

// Exported for the geographic coverage audit (scripts/geo-coverage-health.mjs,
// #5957) — the full-variant news catalog is the reference set the audit counts.
export const FULL_FEEDS: Record<string, Feed[]> = {
  politics: [
    { name: 'BBC World', url: rss('https://feeds.bbci.co.uk/news/world/rss.xml') },
    { name: 'Guardian World', url: rss('https://www.theguardian.com/world/rss') },
    { name: 'AP News', url: rss('https://news.google.com/rss/search?q=site:apnews.com&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Reuters World', url: rss('https://news.google.com/rss/search?q=site:reuters.com+world&hl=en-US&gl=US&ceid=US:en') },
    { name: 'CNN World', url: rss('https://news.google.com/rss/search?q=site:cnn.com+world+news+when:1d&hl=en-US&gl=US&ceid=US:en') },
  ],
  us: [
    { name: 'Reuters US', url: rss('https://news.google.com/rss/search?q=site:reuters.com+US&hl=en-US&gl=US&ceid=US:en') },
    { name: 'NPR News', url: rss('https://feeds.npr.org/1001/rss.xml') },
    { name: 'PBS NewsHour', url: rss('https://www.pbs.org/newshour/feeds/rss/headlines') },
    { name: 'ABC News', url: rss('https://feeds.abcnews.com/abcnews/topstories') },
    { name: 'CBS News', url: rss('https://www.cbsnews.com/latest/rss/main') },
    { name: 'NBC News', url: rss('https://feeds.nbcnews.com/nbcnews/public/news') },
    { name: 'Wall Street Journal', url: rss('https://feeds.content.dowjones.io/public/rss/RSSUSnews') },
    { name: 'Politico', url: rss('https://rss.politico.com/politics-news.xml') },
    { name: 'The Hill', url: rss('https://thehill.com/news/feed') },
    { name: 'Axios', url: rss('https://api.axios.com/feed/') },
    { name: 'Fox News', url: rss('https://moxie.foxnews.com/google-publisher/us.xml') },
    // Canada + North America key-country pack (#5960). CA is a North America
    // keyCountry but had zero dedicated catalog sources. CBC World is the
    // EN-default (noise-acceptable public broadcaster); Globe and Global News
    // stay catalog opt-in. Canadian Press has no usable public RSS/GNews feed.
    { name: 'CBC News', url: rss('https://www.cbc.ca/webfeed/rss/rss-world') },
    { name: 'Globe and Mail', url: rss('https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/canada/?outputType=xml') },
    { name: 'Global News', url: rss('https://globalnews.ca/feed/') },
  ],
  europe: [
    {
      name: 'France 24',
      url: {
        en: rss('https://www.france24.com/en/rss'),
        fr: rss('https://www.france24.com/fr/rss'),
        es: rss('https://www.france24.com/es/rss'),
        ar: rss('https://www.france24.com/ar/rss')
      }
    },
    {
      name: 'EuroNews',
      url: {
        en: rss('https://www.euronews.com/rss?format=xml'),
        fr: rss('https://fr.euronews.com/rss?format=xml'),
        de: rss('https://de.euronews.com/rss?format=xml'),
        it: rss('https://it.euronews.com/rss?format=xml'),
        es: rss('https://es.euronews.com/rss?format=xml'),
        pt: rss('https://pt.euronews.com/rss?format=xml'),
        ru: rss('https://ru.euronews.com/rss?format=xml'),
        gr: rss('https://gr.euronews.com/rss?format=xml'),
      }
    },
    {
      name: 'Le Monde',
      url: {
        en: rss('https://www.lemonde.fr/en/rss/une.xml'),
        fr: rss('https://www.lemonde.fr/rss/une.xml')
      }
    },
    { name: 'DW News', url: { en: rss('https://rss.dw.com/xml/rss-en-all'), de: rss('https://rss.dw.com/xml/rss-de-all'), es: rss('https://news.google.com/rss/search?q=site:dw.com/es&hl=es-419&gl=MX&ceid=MX:es-419') } },
    // Spanish (ES)
    { name: 'El País', url: rss('https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada'), lang: 'es' },
    { name: 'El Mundo', url: rss('https://e00-elmundo.uecdn.es/elmundo/rss/portada.xml'), lang: 'es' },
    { name: 'BBC Mundo', url: rss('https://www.bbc.com/mundo/index.xml'), lang: 'es' },
    // German (DE)
    { name: 'Tagesschau', url: rss('https://www.tagesschau.de/xml/rss2/'), lang: 'de' },
    { name: 'Bild', url: rss('https://www.bild.de/feed/alles.xml'), lang: 'de' },
    { name: 'Der Spiegel', url: rss('https://www.spiegel.de/schlagzeilen/tops/index.rss'), lang: 'de' },
    { name: 'Die Zeit', url: rss('https://newsfeed.zeit.de/index'), lang: 'de' },
    // Italian (IT)
    { name: 'ANSA', url: rss('https://www.ansa.it/sito/notizie/topnews/topnews_rss.xml'), lang: 'it' },
    { name: 'Corriere della Sera', url: rss('https://www.corriere.it/rss/homepage.xml'), lang: 'it' },
    { name: 'Repubblica', url: rss('https://www.repubblica.it/rss/homepage/rss2.0.xml'), lang: 'it' },
    // Dutch (NL)
    { name: 'NOS Nieuws', url: rss('https://feeds.nos.nl/nosnieuwsalgemeen'), lang: 'nl' },
    { name: 'NRC', url: rss('https://www.nrc.nl/rss/'), lang: 'nl' },
    { name: 'De Telegraaf', url: rss('https://news.google.com/rss/search?q=site:telegraaf.nl+when:1d&hl=nl&gl=NL&ceid=NL:nl'), lang: 'nl' },
    // Swedish (SV)
    { name: 'SVT Nyheter', url: rss('https://www.svt.se/nyheter/rss.xml'), lang: 'sv' },
    { name: 'Dagens Nyheter', url: rss('https://www.dn.se/rss/'), lang: 'sv' },
    { name: 'Svenska Dagbladet', url: rss('https://www.svd.se/feed/articles.rss'), lang: 'sv' },
    // Arctic / Nordic security pack (#5960) — High North + Nordics beyond Sweden.
    // no/da/fi are not UI locales, so native Nordics are left unscoped (no lang
    // tag) so EN analysts can enable them. Yle News + Arctic Today are English.
    { name: 'Yle News', url: rss('https://yle.fi/rss/news') },
    { name: 'NRK', url: rss('https://www.nrk.no/nyheter/siste.rss') },
    { name: 'Aftenposten', url: rss('https://www.aftenposten.no/rss') },
    { name: 'DR Nyheder', url: rss('https://www.dr.dk/nyheder/service/feeds/allenyheder') },
    // High North specialty (Berlingske/High North News lack reliable public RSS).
    { name: 'Arctic Today', url: rss('https://news.google.com/rss/search?q=site:arctictoday.com+when:14d&hl=en-US&gl=US&ceid=US:en') },
    // Turkish (TR)
    { name: 'BBC Turkce', url: rss('https://feeds.bbci.co.uk/turkce/rss.xml'), lang: 'tr' },
    { name: 'DW Turkish', url: rss('https://rss.dw.com/xml/rss-tur-all'), lang: 'tr' },
    { name: 'Hurriyet', url: rss('https://www.hurriyet.com.tr/rss/anasayfa'), lang: 'tr', strategicDefault: true },
    // Daily Sabah (EN) — Turkey EN path improvement (#5952). English-language,
    // no lang tag, so EN digests include it as a default-on flank source.
    { name: 'Daily Sabah', url: rss('https://www.dailysabah.com/rss/home-page') },
    // Polish (PL) — TVN24 / Rzeczpospolita are EN-default frontline sources (#5949).
    // Their native RSS feeds are used for both locales: the Google News site
    // queries previously used for EN returned HTTP 200 with no <item> nodes.
    // No `lang` tag so isFeedInLanguage / server digests do not drop them for EN.
    // Polsat News — strategic default via `strategicDefault: true` (#5958).
    { name: 'TVN24', url: {
      en: rss('https://tvn24.pl/swiat.xml'),
      pl: rss('https://tvn24.pl/swiat.xml'),
    } },
    { name: 'Polsat News', url: rss('https://www.polsatnews.pl/rss/wszystkie.xml'), lang: 'pl', strategicDefault: true },
    { name: 'Rzeczpospolita', url: {
      en: rss('https://www.rp.pl/rss_main'),
      pl: rss('https://www.rp.pl/rss_main'),
    } },
    // Hungarian (HU) — V4 / CEE coverage. Locale-gated for hu users only,
    // matching the Tagesschau (de) / ANSA (it) / NOS Nieuws (nl) / SVT (sv)
    // convention. `hu` is registered as a supported locale in src/services/i18n.ts.
    { name: 'Telex', url: rss('https://telex.hu/rss'), lang: 'hu' },
    { name: 'Index.hu', url: rss('https://index.hu/24ora/rss'), lang: 'hu' },
    { name: 'HVG', url: rss('https://hvg.hu/rss'), lang: 'hu' },
    { name: '444.hu', url: rss('https://444.hu/feed'), lang: 'hu' },
    { name: '24.hu', url: rss('https://24.hu/feed/'), lang: 'hu' },
    { name: 'Híradó', url: rss('https://news.google.com/rss/search?q=site:hirado.hu+when:2d&hl=hu&gl=HU&ceid=HU:hu'), lang: 'hu' },
    { name: 'Portfolio.hu', url: rss('https://portfolio.hu/rss/all.xml'), lang: 'hu' },
    { name: 'ATV', url: rss('https://www.atv.hu/rss'), lang: 'hu' },
    // Czech (CS) — V4 balance with Hungary (#5952). Locale-boosted for cs users.
    { name: 'Seznam Zprávy', url: rss('https://www.seznamzpravy.cz/rss'), lang: 'cs' },
    // Croatian (HR) — mainstream + investigative
    { name: 'N1 Croatia', url: rss('https://n1info.hr/feed/'), lang: 'hr' },
    { name: 'Index.hr', url: rss('https://www.index.hr/rss'), lang: 'hr' },
    { name: 'Jutarnji list', url: rss('https://www.jutarnji.hr/feed'), lang: 'hr' },
    { name: 'Balkan Insight', url: rss('https://balkaninsight.com/feed/') },
    // Romanian (RO) — Eastern flank (#5952). Locale-boosted for ro users.
    { name: 'Digi24', url: rss('https://www.digi24.ro/rss'), lang: 'ro' },
    { name: 'HotNews', url: rss('https://www.hotnews.ro/rss'), lang: 'ro' },
    { name: 'G4Media', url: rss('https://www.g4media.ro/feed/'), lang: 'ro' },
    // Bulgarian (BG) — Black Sea flank (#5952). Locale-boosted for bg users.
    { name: 'Dnevnik', url: rss('https://www.dnevnik.bg/rss/'), lang: 'bg' },
    // Greek (EL)
    { name: 'Kathimerini', url: rss('https://news.google.com/rss/search?q=site:kathimerini.gr+when:2d&hl=el&gl=GR&ceid=GR:el'), lang: 'el', strategicDefault: true },
    { name: 'Naftemporiki', url: rss('https://www.naftemporiki.gr/feed/'), lang: 'el' },
    { name: 'in.gr', url: rss('https://www.in.gr/feed/'), lang: 'el' },
    { name: 'iefimerida', url: rss('https://www.iefimerida.gr/rss.xml'), lang: 'el' },
    { name: 'Proto Thema', url: rss('https://news.google.com/rss/search?q=site:protothema.gr+when:2d&hl=el&gl=GR&ceid=GR:el'), lang: 'el' },
    // Baltic states — Eastern flank (#5952). English-language Baltic news
    // services (no lang tag) so EN digests can include them as flank sources.
    { name: 'ERR News', url: rss('https://news.err.ee/rss') },
    { name: 'LRT English', url: rss('https://www.lrt.lt/en/news-in-english?rss') },
    { name: 'LSM English', url: rss('https://eng.lsm.lv/rss/') },
    // Russia & Ukraine — EN default balance rule (#5950):
    // For DEFAULT_ENABLED_SOURCES.europe (EN full-variant path), keep at least:
    //   ≥1 dedicated UA primary (today: Kyiv Independent)
    //   ≥1 independent RU (today: Meduza and/or Moscow Times)
    // Never default-enable TASS / RT / RT Russia (state propaganda; catalog opt-in only).
    // Default EN path must not be “Western wires + RU state media only.”
    // Independent / exile / UA outlets below are eligible for defaults; state media is not.
    { name: 'BBC Russian', url: rss('https://feeds.bbci.co.uk/russian/rss.xml'), lang: 'ru' },
    // Meduza: multi-URL so EN digests use the English RSS (no lang gate); RU UI keeps Russian.
    { name: 'Meduza', url: {
      en: rss('https://meduza.io/rss/en/all'),
      ru: rss('https://meduza.io/rss/all'),
    } },
    { name: 'Novaya Gazeta Europe', url: rss('https://novayagazeta.eu/feed/rss'), lang: 'ru' },
    { name: 'TASS', url: rss('https://news.google.com/rss/search?q=site:tass.com+OR+TASS+Russia+when:1d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'RT', url: rss('https://www.rt.com/rss/') },
    { name: 'RT Russia', url: rss('https://www.rt.com/rss/russia/') },
    // English-language (no lang tag) — always EN-digest-reachable
    { name: 'Kyiv Independent', url: rss('https://news.google.com/rss/search?q=site:kyivindependent.com+when:3d&hl=en-US&gl=US&ceid=US:en') },
    // Ukraine depth pack (#5951) — local institutional + independent sources.
    // Ukrinform / Suspilne are multi-URL so EN digests keep the English edition
    // while `uk` UI users get UA-language Google News (locale boost via url key).
    { name: 'Ukrinform', url: {
      en: rss('https://news.google.com/rss/search?q=site:ukrinform.net+when:3d&hl=en-US&gl=US&ceid=US:en'),
      uk: rss('https://news.google.com/rss/search?q=site:ukrinform.ua+when:3d&hl=uk&gl=UA&ceid=UA:uk'),
    } },
    { name: 'Suspilne', url: {
      en: rss('https://news.google.com/rss/search?q=site:suspilne.media+when:2d&hl=en-US&gl=US&ceid=US:en'),
      uk: rss('https://news.google.com/rss/search?q=site:suspilne.media+when:2d&hl=uk&gl=UA&ceid=UA:uk'),
    } },
    { name: 'Ukrainska Pravda EN', url: rss('https://news.google.com/rss/search?q=site:euromaidanpress.com+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'NV EN', url: rss('https://news.google.com/rss/search?q=site:english.nv.ua+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Hromadske EN', url: rss('https://news.google.com/rss/search?q=site:hromadske.ua+when:3d&hl=en-US&gl=US&ceid=US:en') },
    // Ukrainian (uk) — native-language pack for uk locale (#5959).
    // Locale-gated like Telex (hu) / Digi24 (ro): not EN default-on.
    { name: 'Ukrainska Pravda', url: rss('https://news.google.com/rss/search?q=site:pravda.com.ua+when:2d&hl=uk&gl=UA&ceid=UA:uk'), lang: 'uk' },
    { name: 'Hromadske', url: rss('https://news.google.com/rss/search?q=site:hromadske.ua+when:3d&hl=uk&gl=UA&ceid=UA:uk'), lang: 'uk' },
    { name: 'Bihus.Info', url: rss('https://news.google.com/rss/search?q=site:bihus.info+when:7d&hl=uk&gl=UA&ceid=UA:uk'), lang: 'uk' },
    { name: 'Slidstvo.Info', url: rss('https://news.google.com/rss/search?q=site:slidstvo.info+when:7d&hl=uk&gl=UA&ceid=UA:uk'), lang: 'uk' },
    { name: 'ZN.UA', url: rss('https://news.google.com/rss/search?q=site:zn.ua+when:3d&hl=uk&gl=UA&ceid=UA:uk'), lang: 'uk' },
    { name: 'Moscow Times', url: rss('https://www.themoscowtimes.com/rss/news') },
    // Caucasus (#5953) — secondary Russian periphery / BRI hinterland
    { name: 'Civil.ge', url: rss('https://civil.ge/feed/') },
    { name: 'OC Media', url: rss('https://oc-media.org/feed/') },
    { name: 'JAMnews', url: rss('https://jam-news.net/feed/') },
    // Risk-tagged state wires — Azertag (Azerbaijan) / Armenpress (Armenia)
    { name: 'Azertag', url: rss('https://news.google.com/rss/search?q=site:azertag.az+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Armenpress', url: rss('https://news.google.com/rss/search?q=site:armenpress.am+when:3d&hl=en-US&gl=US&ceid=US:en') },
    // Belarus / Moldova (#5953) — secondary pressure line
    { name: 'Zerkalo', url: rss('https://news.google.com/rss/search?q=site:zerkalo.io+when:2d&hl=en-US&gl=US&ceid=US:en') },
    // NewsMaker removed its English feed; keep the live native Russian feed
    // locale-scoped instead of default-enabling a 404 or mislabeled content.
    { name: 'NewsMaker', url: rss('https://newsmaker.md/feed'), lang: 'ru' },
    { name: 'Ziarul de Gardă', url: rss('https://www.zdg.md/feed/'), lang: 'ro' },
  ],
  middleeast: [
    { name: 'BBC Middle East', url: rss('https://feeds.bbci.co.uk/news/world/middle_east/rss.xml') },
    { name: 'Al Jazeera', url: { en: rss('https://www.aljazeera.com/xml/rss/all.xml'), ar: rss('https://www.aljazeera.net/aljazeerarss/a7c186be-1adb-4b11-a982-4783e765316e/4e17ecdc-8fb9-40de-a5d6-d00f72384a51') } },
    // AlArabiya EN blocks cloud IPs — Google News fallback; AR RSS is direct
    { name: 'Al Arabiya', url: { en: rss('https://news.google.com/rss/search?q=site:english.alarabiya.net+when:2d&hl=en-US&gl=US&ceid=US:en'), ar: rss('https://www.alarabiya.net/tools/mrss/?cat=main') } },
    // Arab News and Times of Israel removed — 403 from cloud IPs
    { name: 'Guardian ME', url: rss('https://www.theguardian.com/world/middleeast/rss') },
    { name: 'BBC Persian', url: rss('https://feeds.bbci.co.uk/persian/rss.xml') },
    { name: 'Iran International', url: rss('https://news.google.com/rss/search?q=site:iranintl.com+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Fars News', url: rss('https://news.google.com/rss/search?q=site:farsnews.ir+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'IRNA', url: rss('https://en.irna.ir/rss') },
    { name: 'Mehr News', url: rss('https://en.mehrnews.com/rss') },
    { name: 'Haaretz', url: rss('https://news.google.com/rss/search?q=site:haaretz.com+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Jerusalem Post', url: rss('https://www.jpost.com/rss/rssfeedsheadlines.aspx') },
    { name: 'Ynetnews', url: rss('https://www.ynetnews.com/Integration/StoryRss3089.xml') },
    { name: 'Arab News', url: rss('https://news.google.com/rss/search?q=site:arabnews.com+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'The National', url: rss('https://news.google.com/rss/search?q=site:thenationalnews.com+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Oman Observer', url: rss('https://www.omanobserver.om/rssFeed/1') },
    { name: 'Asharq Business', url: rss('https://asharqbusiness.com/rss.xml') },
    { name: 'Asharq News', url: rss('https://asharq.com/snapchat/rss.xml'), lang: 'ar' },
    { name: 'Rudaw', url: rss('https://news.google.com/rss/search?q=site:rudaw.net+when:7d&hl=en&gl=US&ceid=US:en') },
  ],
  tech: [
    { name: 'Hacker News', url: rss('https://hnrss.org/frontpage') },
    { name: 'Ars Technica', url: rss('https://feeds.arstechnica.com/arstechnica/technology-lab') },
    { name: 'The Verge', url: rss('https://www.theverge.com/rss/index.xml') },
    { name: 'MIT Tech Review', url: rss('https://www.technologyreview.com/feed/') },
  ],
  ai: [
    { name: 'AI News', url: rss('https://news.google.com/rss/search?q=(OpenAI+OR+Anthropic+OR+Google+AI+OR+"large+language+model"+OR+ChatGPT)+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'VentureBeat AI', url: rss('https://venturebeat.com/category/ai/feed/') },
    { name: 'The Verge AI', url: rss('https://www.theverge.com/rss/ai-artificial-intelligence/index.xml') },
    { name: 'MIT Tech Review', url: rss('https://www.technologyreview.com/topic/artificial-intelligence/feed') },
    { name: 'ArXiv AI', url: rss('https://export.arxiv.org/rss/cs.AI') },
  ],
  finance: [
    { name: 'CNBC', url: rss('https://www.cnbc.com/id/100003114/device/rss/rss.html') },
    { name: 'MarketWatch', url: rss('https://news.google.com/rss/search?q=site:marketwatch.com+markets+when:1d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Yahoo Finance', url: rss('https://finance.yahoo.com/news/rssindex') },
    { name: 'Financial Times', url: rss('https://www.ft.com/rss/home') },
    { name: 'Reuters Business', url: rss('https://news.google.com/rss/search?q=site:reuters.com+business+markets&hl=en-US&gl=US&ceid=US:en') },
  ],
  gov: [
    { name: 'White House', url: rss('https://news.google.com/rss/search?q=site:whitehouse.gov&hl=en-US&gl=US&ceid=US:en') },
    { name: 'State Dept', url: rss('https://news.google.com/rss/search?q=site:state.gov+OR+"State+Department"&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Pentagon', url: rss('https://news.google.com/rss/search?q=site:defense.gov+OR+Pentagon&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Treasury', url: rss('https://news.google.com/rss/search?q=site:treasury.gov+OR+"Treasury+Department"&hl=en-US&gl=US&ceid=US:en') },
    { name: 'DOJ', url: rss('https://news.google.com/rss/search?q=site:justice.gov+OR+"Justice+Department"+DOJ&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Federal Reserve', url: rss('https://www.federalreserve.gov/feeds/press_all.xml') },
    { name: 'SEC', url: rss('https://www.sec.gov/news/pressreleases.rss') },
    { name: 'CDC', url: rss('https://news.google.com/rss/search?q=site:cdc.gov+OR+CDC+health&hl=en-US&gl=US&ceid=US:en') },
    { name: 'FEMA', url: rss('https://news.google.com/rss/search?q=site:fema.gov+OR+FEMA+emergency&hl=en-US&gl=US&ceid=US:en') },
    { name: 'DHS', url: rss('https://news.google.com/rss/search?q=site:dhs.gov+OR+"Homeland+Security"&hl=en-US&gl=US&ceid=US:en') },
    { name: 'UN News', url: railwayRss('https://news.un.org/feed/subscribe/en/news/all/rss.xml') },
    { name: 'CISA', url: railwayRss('https://www.cisa.gov/cybersecurity-advisories/all.xml') },
  ],
  layoffs: [
    { name: 'Layoffs.fyi', url: rss('https://news.google.com/rss/search?q=tech+company+layoffs+announced&hl=en&gl=US&ceid=US:en') },
    { name: 'TechCrunch Layoffs', url: rss('https://techcrunch.com/tag/layoffs/feed/') },
    { name: 'Layoffs News', url: rss('https://news.google.com/rss/search?q=(layoffs+OR+"job+cuts"+OR+"workforce+reduction")+when:3d&hl=en-US&gl=US&ceid=US:en') },
  ],
  thinktanks: [
    { name: 'Foreign Policy', url: rss('https://foreignpolicy.com/feed/') },
    { name: 'Atlantic Council', url: railwayRss('https://www.atlanticcouncil.org/feed/') },
    { name: 'Foreign Affairs', url: rss('https://www.foreignaffairs.com/rss.xml') },
    { name: 'CSIS', url: rss('https://news.google.com/rss/search?q=site:csis.org+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'RAND', url: rss('https://www.rand.org/pubs/articles.xml') },
    { name: 'Brookings', url: rss('https://news.google.com/rss/search?q=site:brookings.edu+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Carnegie', url: rss('https://news.google.com/rss/search?q=site:carnegieendowment.org+when:7d&hl=en-US&gl=US&ceid=US:en') },
    // New verified think tank feeds
    // War on the Rocks - Defense and national security analysis
    { name: 'War on the Rocks', url: rss('https://warontherocks.com/feed') },
    // Responsible Statecraft - Foreign policy analysis (Quincy Institute)
    { name: 'Responsible Statecraft', url: rss('https://responsiblestatecraft.org/feed/') },
    // RUSI - Royal United Services Institute (UK defense & security)
    { name: 'RUSI', url: rss('https://news.google.com/rss/search?q=site:rusi.org+when:3d&hl=en-US&gl=US&ceid=US:en') },
    // FPRI - Foreign Policy Research Institute (US foreign policy)
    { name: 'FPRI', url: rss('https://www.fpri.org/feed/') },
    // Jamestown Foundation - Eurasia/China/Terrorism analysis
    { name: 'Jamestown', url: rss('https://jamestown.org/feed/') },
    // ISW — Institute for the Study of War, daily Ukraine frontline operational assessments
    { name: 'ISW', url: rss('https://news.google.com/rss/search?q=site:understandingwar.org+when:2d&hl=en-US&gl=US&ceid=US:en') },
  ],
  crisis: [
    { name: 'CrisisWatch', url: rss('https://www.crisisgroup.org/rss') },
    { name: 'IAEA', url: rss('https://www.iaea.org/feeds/topnews') },
    { name: 'WHO', url: rss('https://www.who.int/rss-feeds/news-english.xml') },
    { name: 'UNHCR', url: rss('https://news.google.com/rss/search?q=site:unhcr.org+OR+UNHCR+refugees+when:3d&hl=en-US&gl=US&ceid=US:en') },
  ],
  africa: [
    { name: 'Africa News', url: rss('https://news.google.com/rss/search?q=(Africa+OR+Nigeria+OR+Kenya+OR+"South+Africa"+OR+Ethiopia)+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Sahel Crisis', url: rss('https://news.google.com/rss/search?q=(Sahel+OR+Mali+OR+Niger+OR+"Burkina+Faso"+OR+Wagner)+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'News24', url: rss('https://feeds.news24.com/articles/news24/TopStories/rss') },
    { name: 'BBC Africa', url: rss('https://feeds.bbci.co.uk/news/world/africa/rss.xml') },
    { name: 'Jeune Afrique', url: rss('https://www.jeuneafrique.com/feed/'), lang: 'fr', strategicDefault: true },
    { name: 'Africanews', url: { en: rss('https://www.africanews.com/feed/rss'), fr: rss('https://fr.africanews.com/feed/rss') } },
    { name: 'BBC Afrique', url: rss('https://www.bbc.com/afrique/index.xml'), lang: 'fr' },
    // Nigeria
    { name: 'Premium Times', url: rss('https://www.premiumtimesng.com/feed') },
    { name: 'Vanguard Nigeria', url: rss('https://www.vanguardngr.com/feed/') },
    { name: 'Channels TV', url: rss('https://www.channelstv.com/feed/') },
    { name: 'Daily Trust', url: rss('https://dailytrust.com/feed/') },
    { name: 'ThisDay', url: rss('https://www.thisdaylive.com/feed') },
    // Horn of Africa
    { name: 'Radio Tamazuj', url: rss('https://www.radiotamazuj.org/en/feed') },
    { name: 'The Reporter Ethiopia', url: rss('https://www.thereporterethiopia.com/feed/') },
    { name: 'Ethiopia Insight', url: rss('https://www.ethiopia-insight.com/feed/') },
    { name: 'Dabanga Sudan', url: rss('https://www.dabangasudan.org/en/feed') },
    { name: 'Hiiraan Online', url: rss('https://news.google.com/rss/search?q=site%3Ahiiraan.com%20when%3A7d&hl=en-US&gl=US&ceid=US:en') },
    // DRC / Great Lakes
    { name: 'Actualite.cd', url: rss('https://actualite.cd/feed'), lang: 'fr' },
    { name: 'Radio Okapi', url: rss('https://www.radiookapi.net/rss.xml'), lang: 'fr' },
    // West Africa beyond Nigeria
    { name: 'MyJoyOnline', url: rss('https://www.myjoyonline.com/feed/') },
    { name: 'Citi Newsroom', url: rss('https://news.google.com/rss/search?q=site%3Acitinewsroom.com%20when%3A7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Le Quotidien', url: rss('https://lequotidien.sn/feed/'), lang: 'fr' },
    // Pan-African
    { name: 'RFI Afrique', url: rss('https://www.rfi.fr/en/africa/rss') },
  ],
  latam: [
    { name: 'Latin America', url: rss('https://news.google.com/rss/search?q=(Brazil+OR+Mexico+OR+Argentina+OR+Venezuela+OR+Colombia)+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'BBC Latin America', url: rss('https://feeds.bbci.co.uk/news/world/latin_america/rss.xml') },
    { name: 'Reuters LatAm', url: rss('https://news.google.com/rss/search?q=site:reuters.com+(Brazil+OR+Mexico+OR+Argentina)+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Guardian Americas', url: rss('https://www.theguardian.com/world/americas/rss') },
    // Localized Feeds
    { name: 'Clarín', url: rss('https://www.clarin.com/rss/lo-ultimo/'), lang: 'es' },
    { name: 'O Globo', url: rss('https://news.google.com/rss/search?q=site:oglobo.globo.com+when:1d&hl=pt-BR&gl=BR&ceid=BR:pt-419'), lang: 'pt' },
    { name: 'Folha de S.Paulo', url: rss('https://feeds.folha.uol.com.br/emcimadahora/rss091.xml'), lang: 'pt' },
    { name: 'Brasil Paralelo', url: rss('https://www.brasilparalelo.com.br/noticias/rss.xml'), lang: 'pt' },
    { name: 'El Tiempo', url: rss('https://www.eltiempo.com/rss/mundo_latinoamerica.xml'), lang: 'es' },
    { name: 'La Silla Vacía', url: rss('https://www.lasillavacia.com/rss') },
    { name: 'Primicias', url: rss('https://www.primicias.ec/feed/'), lang: 'es' },
    { name: 'Infobae Americas', url: rss('https://www.infobae.com/arc/outboundfeeds/rss/'), lang: 'es' },
    { name: 'El Universo', url: rss('https://www.eluniverso.com/arc/outboundfeeds/rss/category/noticias/?outputType=xml'), lang: 'es' },
    // Mexico
    { name: 'Mexico News Daily', url: rss('https://mexiconewsdaily.com/feed/') },
    { name: 'Mexico Security', url: rss('https://news.google.com/rss/search?q=(Mexico+cartel+OR+Mexico+violence+OR+Mexico+troops+OR+narco+Mexico)+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'AP Mexico', url: rss('https://news.google.com/rss/search?q=site:apnews.com+Mexico+when:3d&hl=en-US&gl=US&ceid=US:en') },
    // LatAm Security
    { name: 'InSight Crime', url: rss('https://insightcrime.org/feed/') },
    { name: 'France 24 LatAm', url: rss('https://www.france24.com/en/americas/rss') },
  ],
  asia: [
    { name: 'Asia News', url: rss('https://news.google.com/rss/search?q=(China+OR+Japan+OR+Korea+OR+India+OR+ASEAN)+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'BBC Asia', url: rss('https://feeds.bbci.co.uk/news/world/asia/rss.xml') },
    { name: 'The Diplomat', url: rss('https://thediplomat.com/feed/') },
    { name: 'South China Morning Post', url: railwayRss('https://www.scmp.com/rss/91/feed/') },
    { name: 'Reuters Asia', url: rss('https://news.google.com/rss/search?q=site:reuters.com+(China+OR+Japan+OR+Taiwan+OR+Korea)+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Xinhua', url: rss('https://news.google.com/rss/search?q=site:xinhuanet.com+OR+Xinhua+when:1d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Japan Today', url: rss('https://japantoday.com/feed/atom') },
    { name: 'Nikkei Asia', url: rss('https://news.google.com/rss/search?q=site:asia.nikkei.com+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Asahi Shimbun', url: rss('https://www.asahi.com/rss/asahi/newsheadlines.rdf'), lang: 'ja', strategicDefault: true },
    { name: 'The Hindu', url: rss('https://www.thehindu.com/news/national/feeder/default.rss'), lang: 'en' },
    { name: 'Indian Express', url: rss('https://indianexpress.com/section/india/feed/') },
    { name: 'NDTV', url: rss('https://feeds.feedburner.com/ndtvnews-top-stories') },
    { name: 'India News Network', url: rss('https://news.google.com/rss/search?q=India+diplomacy+foreign+policy+news&hl=en&gl=US&ceid=US:en') },
    // Hindi (HI) — mainstream national coverage boosted for Hindi locale users
    { name: 'BBC Hindi', url: rss('https://feeds.bbci.co.uk/hindi/rss.xml'), lang: 'hi' },
    { name: 'Aaj Tak', url: rss('https://www.aajtak.in/rssfeeds/?id=home'), lang: 'hi' },
    { name: 'NDTV India', url: rss('https://feeds.feedburner.com/ndtvkhabar-latest'), lang: 'hi' },
    { name: 'Amar Ujala', url: rss('https://www.amarujala.com/rss/national.xml'), lang: 'hi' },
    { name: 'CNA', url: rss('https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml') },
    { name: 'MIIT (China)', url: rss('https://news.google.com/rss/search?q=site:miit.gov.cn+when:7d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans'), lang: 'zh', strategicDefault: true },
    { name: 'MOFCOM (China)', url: rss('https://news.google.com/rss/search?q=site:mofcom.gov.cn+when:7d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans'), lang: 'zh', strategicDefault: true },
    // Thailand
    { name: 'Bangkok Post', url: rss('https://news.google.com/rss/search?q=site:bangkokpost.com+when:1d&hl=en-US&gl=US&ceid=US:en'), lang: 'th', strategicDefault: true },
    { name: 'Thai PBS', url: rss('https://news.google.com/rss/search?q=Thai+PBS+World+news&hl=en&gl=US&ceid=US:en'), lang: 'th' },
    // Vietnam
    { name: 'VnExpress', url: rss('https://vnexpress.net/rss/tin-moi-nhat.rss'), lang: 'vi', strategicDefault: true },
    { name: 'Tuoi Tre News', url: rss('https://tuoitrenews.vn/rss'), lang: 'vi' },
    // Korea
    { name: 'Yonhap News', url: rss('https://www.yonhapnewstv.co.kr/browse/feed/'), lang: 'ko', strategicDefault: true },
    { name: 'Chosun Ilbo', url: rss('https://www.chosun.com/arc/outboundfeeds/rss/?outputType=xml'), lang: 'ko' },
    // Australia
    { name: 'ABC News Australia', url: rss('https://www.abc.net.au/news/feed/2942460/rss.xml') },
    { name: 'Guardian Australia', url: rss('https://www.theguardian.com/australia-news/rss') },
    // Pacific Islands
    { name: 'Island Times (Palau)', url: rss('https://islandtimes.org/feed/') },
    // Central Asia (#5953) — Russia rear area, China BRI, sanctions leakage
    { name: 'Eurasianet', url: rss('https://eurasianet.org/rss') },
    { name: 'RFE/RL Central Asia', url: rss('https://news.google.com/rss/search?q=site:rferl.org+Central+Asia+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'The Astana Times', url: rss('https://astanatimes.com/feed/') },
    { name: 'The Times of Central Asia', url: rss('https://timesca.com/feed/') },
    // Taiwan (#5954)
    { name: 'Focus Taiwan', url: rss('https://news.google.com/rss/search?q=site%3Afocustaiwan.tw%20when%3A3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Taipei Times', url: rss('https://news.google.com/rss/search?q=site%3Ataipeitimes.com%20when%3A3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Taiwan News', url: rss('https://news.google.com/rss/search?q=site%3Ataiwannews.com.tw%20when%3A3d&hl=en-US&gl=US&ceid=US:en') },
    // Pakistan (#5954)
    { name: 'Dawn', url: rss('https://www.dawn.com/feeds/home/') },
    { name: 'Geo News', url: rss('https://news.google.com/rss/search?q=site:geo.tv+when:2d&hl=en-US&gl=US&ceid=US:en') },
    // SE Asia security (#5954)
    { name: 'Jakarta Post', url: rss('https://news.google.com/rss/search?q=site%3Athejakartapost.com%20when%3A3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Rappler', url: rss('https://www.rappler.com/feed/') },
    { name: 'The Star (Malaysia)', url: rss('https://news.google.com/rss/search?q=site%3Athestar.com.my%20when%3A3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Irrawaddy', url: rss('https://www.irrawaddy.com/feed/') },
  ],
  energy: [
    { name: 'Oil & Gas', url: rss('https://news.google.com/rss/search?q=(oil+price+OR+OPEC+OR+"natural+gas"+OR+pipeline+OR+LNG)+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Nuclear Energy', url: rss('https://news.google.com/rss/search?q=("nuclear+energy"+OR+"nuclear+power"+OR+uranium+OR+IAEA)+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Reuters Energy', url: rss('https://news.google.com/rss/search?q=site:reuters.com+(oil+OR+gas+OR+energy+OR+OPEC)+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Mining & Resources', url: rss('https://news.google.com/rss/search?q=(lithium+OR+"rare+earth"+OR+cobalt+OR+mining)+when:3d&hl=en-US&gl=US&ceid=US:en') },
  ],
};

// Variant-aware exports
export const FEEDS = FULL_FEEDS;

// Canonical category→feeds map: the union of every variant's feed set.
// `FEEDS` (above) is just the active variant's PRESET; users freely customize
// their panel set, so any enabled news panel must be able to resolve its feeds
// regardless of which variant it "belongs" to. Consumers:
//  • data-loader `loadNews()` — loads preset categories + custom enabled panels
//  • panel-layout — creates a NewsPanel for any enabled category, not just preset
// See src/config/feed-resolution.ts for the merge + resolution helpers.
export const CANONICAL_FEEDS: Record<string, Feed[]> = mergeCanonicalFeeds([
  FULL_FEEDS,
]);

export const SOURCE_REGION_MAP: Record<string, { labelKey: string; feedKeys: string[] }> = {
  // Full (geopolitical) variant regions
  worldwide: { labelKey: 'header.sourceRegionWorldwide', feedKeys: ['politics', 'crisis'] },
  us: { labelKey: 'header.sourceRegionUS', feedKeys: ['us', 'gov'] },
  europe: { labelKey: 'header.sourceRegionEurope', feedKeys: ['europe'] },
  middleeast: { labelKey: 'header.sourceRegionMiddleEast', feedKeys: ['middleeast'] },
  africa: { labelKey: 'header.sourceRegionAfrica', feedKeys: ['africa'] },
  latam: { labelKey: 'header.sourceRegionLatAm', feedKeys: ['latam'] },
  asia: { labelKey: 'header.sourceRegionAsiaPacific', feedKeys: ['asia'] },
  topical: { labelKey: 'header.sourceRegionTopical', feedKeys: ['energy', 'tech', 'ai', 'finance', 'layoffs', 'thinktanks'] },
  intel: { labelKey: 'header.sourceRegionIntel', feedKeys: [] },

};

export const INTEL_SOURCES: Feed[] = [
  // Defense & Security (Tier 1)
  { name: 'Defense One', url: rss('https://www.defenseone.com/rss/all/'), type: 'defense' },
  { name: 'The War Zone', url: rss('https://www.twz.com/feed'), type: 'defense' },
  { name: 'Defense News', url: rss('https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml'), type: 'defense' },
  { name: 'Janes', url: rss('https://news.google.com/rss/search?q=site:janes.com+when:3d&hl=en-US&gl=US&ceid=US:en'), type: 'defense' },
  { name: 'Military Times', url: rss('https://www.militarytimes.com/arc/outboundfeeds/rss/?outputType=xml'), type: 'defense' },
  { name: 'Task & Purpose', url: rss('https://taskandpurpose.com/feed/'), type: 'defense' },
  { name: 'USNI News', url: rss('https://news.google.com/rss/search?q=site:news.usni.org+when:3d&hl=en-US&gl=US&ceid=US:en'), type: 'defense' },
  { name: 'gCaptain', url: rss('https://gcaptain.com/feed/'), type: 'defense' },
  { name: 'Oryx OSINT', url: rss('https://www.oryxspioenkop.com/feeds/posts/default?alt=rss'), type: 'defense' },
  // Declared LAST in the defense group on purpose. The free-tier source cap
  // (selectSourcesUnderCap, FREE_MAX_SOURCES) fills category buckets round-robin
  // in DECLARATION ORDER, and the intel bucket only gets a handful of slots — so
  // inserting a new name near the top silently evicts whichever default-enabled
  // source it pushes past the cap. That eviction is written back into
  // worldmonitor-disabled-feeds and cloud-synced rather than recomputed, so it
  // never recovers. Appending makes a new source absorb its own cap cost instead
  // of deleting an existing one from every free-tier user (#5405 review).
  { name: 'Breaking Defense', url: rss('https://breakingdefense.com/feed/'), type: 'defense' },
  { name: 'UK MOD', url: rss('https://www.gov.uk/government/organisations/ministry-of-defence.atom'), type: 'defense' },
  { name: 'CSIS', url: rss('https://news.google.com/rss/search?q=site:csis.org&hl=en&gl=US&ceid=US:en'), type: 'defense' },

  // International Relations (Tier 2)
  { name: 'Chatham House', url: rss('https://news.google.com/rss/search?q=site:chathamhouse.org+when:7d&hl=en-US&gl=US&ceid=US:en'), type: 'intl' },
  { name: 'ECFR', url: rss('https://news.google.com/rss/search?q=site:ecfr.eu+when:7d&hl=en-US&gl=US&ceid=US:en'), type: 'intl' },
  { name: 'Foreign Policy', url: rss('https://foreignpolicy.com/feed/'), type: 'intl' },
  { name: 'Foreign Affairs', url: rss('https://www.foreignaffairs.com/rss.xml'), type: 'intl' },
  { name: 'Atlantic Council', url: railwayRss('https://www.atlanticcouncil.org/feed/'), type: 'intl' },
  { name: 'Middle East Institute', url: rss('https://news.google.com/rss/search?q=site:mei.edu+when:7d&hl=en-US&gl=US&ceid=US:en'), type: 'intl' },

  // Think Tanks & Research (Tier 3)
  { name: 'RAND', url: rss('https://www.rand.org/pubs/articles.xml'), type: 'research' },
  { name: 'Brookings', url: rss('https://news.google.com/rss/search?q=site:brookings.edu&hl=en&gl=US&ceid=US:en'), type: 'research' },
  { name: 'Carnegie', url: rss('https://news.google.com/rss/search?q=site:carnegieendowment.org&hl=en&gl=US&ceid=US:en'), type: 'research' },
  { name: 'FAS', url: rss('https://news.google.com/rss/search?q=site:fas.org+nuclear+weapons+security&hl=en&gl=US&ceid=US:en'), type: 'research' },
  { name: 'NTI', url: rss('https://news.google.com/rss/search?q=site:nti.org+when:30d&hl=en-US&gl=US&ceid=US:en'), type: 'research' },
  { name: 'RUSI', url: rss('https://news.google.com/rss/search?q=site:rusi.org+when:7d&hl=en-US&gl=US&ceid=US:en'), type: 'research' },
  { name: 'Wilson Center', url: rss('https://news.google.com/rss/search?q=site:wilsoncenter.org+when:7d&hl=en-US&gl=US&ceid=US:en'), type: 'research' },
  { name: 'GMF', url: rss('https://news.google.com/rss/search?q=site:gmfus.org+when:7d&hl=en-US&gl=US&ceid=US:en'), type: 'research' },
  { name: 'Stimson Center', url: rss('https://www.stimson.org/feed/'), type: 'research' },
  { name: 'CNAS', url: rss('https://news.google.com/rss/search?q=site:cnas.org+when:7d&hl=en-US&gl=US&ceid=US:en'), type: 'research' },
  { name: 'Lowy Institute', url: rss('https://news.google.com/rss/search?q=site:lowyinstitute.org+when:7d&hl=en-US&gl=US&ceid=US:en'), type: 'research' },

  // Nuclear & Arms Control (Tier 2)
  { name: 'Arms Control Assn', url: rss('https://news.google.com/rss/search?q=site:armscontrol.org+when:7d&hl=en-US&gl=US&ceid=US:en'), type: 'nuclear' },
  { name: 'Bulletin of Atomic Scientists', url: rss('https://news.google.com/rss/search?q=site:thebulletin.org+when:7d&hl=en-US&gl=US&ceid=US:en'), type: 'nuclear' },

  // OSINT & Monitoring (Tier 2)
  { name: 'Bellingcat', url: rss('https://news.google.com/rss/search?q=site:bellingcat.com+when:30d&hl=en-US&gl=US&ceid=US:en'), type: 'osint' },
  { name: 'Krebs Security', url: rss('https://krebsonsecurity.com/feed/'), type: 'cyber' },
  { name: 'Ransomware.live', url: rss('https://www.ransomware.live/rss.xml'), type: 'cyber' },

  // Economic & Food Security (Tier 2)
  { name: 'FAO News', url: rss('https://www.fao.org/feeds/fao-newsroom-rss'), type: 'economic' },
  { name: 'FAO GIEWS', url: rss('https://news.google.com/rss/search?q=site:fao.org+GIEWS+food+security+when:30d&hl=en-US&gl=US&ceid=US:en'), type: 'economic' },

  // Investigative Journalism & Accountability
  // Cross-border corruption & organized crime investigations (Panama Papers, Pandora Papers)
  { name: 'OCCRP', url: rss('https://www.occrp.org/en/feed'), type: 'investigative' },
  // Atlantic Council Digital Forensic Research Lab — disinformation/influence operations
  { name: 'DFRLab', url: rss('https://dfrlab.org/feed/'), type: 'investigative' },
  // European investigative collective — migration, extremism, accountability
  { name: 'Lighthouse Reports', url: rss('https://www.lighthousereports.com/feed/'), type: 'investigative' },
  // Africa-focused: war crimes, illicit finance, sanctions evasion
  { name: 'The Sentry', url: rss('https://thesentry.org/feed/'), type: 'investigative' },
  // Global Initiative Against Transnational Organized Crime
  { name: 'GITOC', url: rss('https://globalinitiative.net/feed/'), type: 'investigative' },
  // V4/CEE investigative network (OCCRP member)
  { name: 'VSquare', url: rss('https://vsquare.org/feed/'), type: 'investigative' },
  // German investigative journalism & fact-checking nonprofit
  { name: 'Correctiv', url: rss('https://correctiv.org/feed/'), type: 'investigative' },

  { name: 'EU ISS', url: rss('https://news.google.com/rss/search?q=site:iss.europa.eu+when:7d&hl=en-US&gl=US&ceid=US:en'), type: 'intl' },
];

/** Unique configured feed names across every variant map + intel sources. */
export function listConfiguredFeedNames(): string[] {
  const names = new Set<string>();
  for (const feeds of Object.values(CANONICAL_FEEDS)) {
    for (const feed of feeds) names.add(feed.name);
  }
  for (const feed of INTEL_SOURCES) names.add(feed.name);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Provenance state for a configured feed.
 * `reviewed` = present in SOURCE_PROPAGANDA_RISK (any risk including explicit low).
 * `unknown` = not yet reviewed — API still returns a definite profile via getSourcePropagandaRisk.
 */
export function getFeedProvenanceState(sourceName: string): SourceProvenanceState {
  return getSourceProvenanceState(sourceName);
}

/**
 * Ukraine-war frontline + UA/RU balance sources that free-tier source-cap
 * must not strip (#5949, #5950). Passed to `selectSourcesUnderCap` as
 * `protectedNames` so round-robin late-in-bucket ordering cannot drop the
 * dedicated UA primary / independent RU / PL frontline set for free EN users.
 * Keep in sync with DEFAULT_ENABLED_SOURCES.europe frontline additions and
 * the one-shot migration in App.ts (`worldmonitor-frontline-europe-enable-v1`).
 */
export const FRONTLINE_EUROPE_PROTECTED_SOURCES = [
  'Kyiv Independent',
  'TVN24',
  'Rzeczpospolita',
  'Meduza',
  'Moscow Times',
  'Ukrainska Pravda EN',
  'NV EN',
] as const;

const EASTERN_FLANK_EN_DEFAULT_SOURCES = [
  'Daily Sabah',
  'ERR News',
] as const;

const AFRICA_DEPTH_EN_DEFAULT_SOURCES = [
  'Hiiraan Online',
  'RFI Afrique',
] as const;

const CAUCASUS_EN_DEFAULT_SOURCES = [
  'Civil.ge',
  'OC Media',
] as const;

const CENTRAL_ASIA_EN_DEFAULT_SOURCES = [
  'Eurasianet',
  'The Astana Times',
] as const;

const INDO_PACIFIC_EN_DEFAULT_SOURCES = [
  'Focus Taiwan',
  'Dawn',
  'Rappler',
] as const;

/** Current editorial defaults introduced by the four regional feed PRs. */
export const REGIONAL_FEED_ROLLOUT_DEFAULT_SOURCES = [
  ...EASTERN_FLANK_EN_DEFAULT_SOURCES,
  ...CAUCASUS_EN_DEFAULT_SOURCES,
  ...CENTRAL_ASIA_EN_DEFAULT_SOURCES,
  ...INDO_PACIFIC_EN_DEFAULT_SOURCES,
  ...AFRICA_DEPTH_EN_DEFAULT_SOURCES,
] as const;

/**
 * Current opt-in sources introduced by the same rollout wave. Persisted
 * denylist profiles need these names inserted by the schema-5 migration;
 * otherwise a newly cataloged source is implicitly enabled for every returner.
 */
export const REGIONAL_FEED_ROLLOUT_OPT_IN_SOURCES = [
  'Seznam Zprávy', 'Digi24', 'HotNews', 'G4Media', 'Dnevnik',
  'LRT English', 'LSM English',
  'JAMnews', 'Azertag', 'Armenpress', 'Zerkalo', 'NewsMaker', 'Ziarul de Gardă',
  'Radio Tamazuj', 'The Reporter Ethiopia', 'Actualite.cd', 'Radio Okapi',
  'MyJoyOnline', 'Le Quotidien', 'RFE/RL Central Asia', 'The Times of Central Asia',
  'Taipei Times', 'Taiwan News', 'Geo News', 'Jakarta Post',
  'The Star (Malaysia)', 'Irrawaddy',
  'Ethiopia Insight', 'Dabanga Sudan', 'Citi Newsroom',
] as const;

/** Canada pack (#5960) — EN default-on for North America keyCountry CA. */
export const CANADA_EN_DEFAULT_SOURCES = [
  'CBC News',
] as const;

/**
 * Catalog opt-in sources from the Canada + Arctic/Nordic pack (#5960).
 * Persisted denylist profiles must insert these on first boot after the pack
 * lands — otherwise newly cataloged names are implicitly enabled for every
 * returner (denylist semantics). CBC stays out so default-on can enable it.
 */
export const CANADA_ARCTIC_OPT_IN_SOURCES = [
  'Globe and Mail',
  'Global News',
  'Yle News',
  'NRK',
  'Aftenposten',
  'DR Nyheder',
  'Arctic Today',
] as const;

/** Chronological feed introductions used to reconstruct untouched cap states. */
export const REGIONAL_FEED_ROLLOUT_STAGES = [
  {
    introducedNames: [
      'Civil.ge', 'OC Media', 'JAMnews', 'Azertag', 'Armenpress', 'Zerkalo',
      'NewsMaker', 'Ziarul de Gardă', 'Radio Tamazuj', 'The Reporter Ethiopia',
      'Actualite.cd', 'Radio Okapi', 'MyJoyOnline', 'Le Quotidien',
      'Eurasianet', 'RFE/RL Central Asia', 'The Astana Times', 'The Times of Central Asia',
    ],
    protectedNames: [...FRONTLINE_EUROPE_PROTECTED_SOURCES],
  },
  {
    introducedNames: [
      'Focus Taiwan', 'Taipei Times', 'Taiwan News', 'Dawn', 'Geo News',
      'Jakarta Post', 'Rappler', 'The Star (Malaysia)', 'Irrawaddy',
    ],
    protectedNames: [...FRONTLINE_EUROPE_PROTECTED_SOURCES],
  },
  {
    introducedNames: [
      'Daily Sabah', 'Seznam Zprávy', 'Digi24', 'HotNews', 'G4Media',
      'Dnevnik', 'ERR News', 'LRT English', 'LSM English',
    ],
    protectedNames: [
      ...FRONTLINE_EUROPE_PROTECTED_SOURCES,
      ...EASTERN_FLANK_EN_DEFAULT_SOURCES,
    ],
  },
  {
    introducedNames: [
      'Ethiopia Insight', 'Dabanga Sudan', 'Hiiraan Online', 'Citi Newsroom', 'RFI Afrique',
    ],
    protectedNames: [
      ...FRONTLINE_EUROPE_PROTECTED_SOURCES,
      ...EASTERN_FLANK_EN_DEFAULT_SOURCES,
      ...AFRICA_DEPTH_EN_DEFAULT_SOURCES,
    ],
  },
  {
    // #5960 is newer than the schema-5 regional wave. Keeping its names in a
    // final chronological stage removes them from every pre-pack fingerprint
    // while still allowing current-cap states to be reconstructed after it.
    introducedNames: [
      ...CANADA_EN_DEFAULT_SOURCES,
      ...CANADA_ARCTIC_OPT_IN_SOURCES,
    ],
    protectedNames: [
      ...FRONTLINE_EUROPE_PROTECTED_SOURCES,
      ...REGIONAL_FEED_ROLLOUT_DEFAULT_SOURCES,
      ...CANADA_EN_DEFAULT_SOURCES,
    ],
  },
] as const;

/**
 * Editorially required EN defaults that must survive the free-tier source cap.
 * Keep the narrower frontline set above for its one-shot migration contract;
 * this broader set is only for current cap selection.
 */
export const FREE_CAP_PROTECTED_SOURCES = [
  ...FRONTLINE_EUROPE_PROTECTED_SOURCES,
  ...REGIONAL_FEED_ROLLOUT_DEFAULT_SOURCES,
  ...CANADA_EN_DEFAULT_SOURCES,
] as const;

/**
 * Sources that are default-enabled for every UI language.
 *
 * This is derived from the feed declarations so a strategic source cannot be
 * added to the client reachability path without also entering the canonical
 * default-enabled set and the free-tier protection path.
 */
export function getStrategicDefaultSources(): Set<string> {
  const strategic = new Set<string>();
  for (const feeds of Object.values(FULL_FEEDS)) {
    for (const feed of feeds) {
      if (feed.strategicDefault) strategic.add(feed.name);
    }
  }
  for (const feed of INTEL_SOURCES) {
    if (feed.strategicDefault) strategic.add(feed.name);
  }
  return strategic;
}

/**
 * Default sources enabled for every user on first boot.
 *
 * Two separate concepts control whether a feed is visible to a user:
 *
 * **Locale boost** — feeds tagged with `lang: <code>` are auto-enabled for
 * users whose UI language matches that code (e.g. Hungarian users see Telex).
 * This is the `getLocaleBoostedSources()` mechanism. It only fires for non-EN
 * locales — English is the baseline, not "boosted".
 *
 * **Strategic defaults** — feeds tagged `strategicDefault: true` are always
 * default-enabled regardless of UI language. These carry local-depth coverage
 * of active wars, frontline NATO states, and Tier-1 Indo-Pacific flashpoints
 * that every intel audience should see (e.g. Asahi Shimbun for Japan, Yonhap
 * for Korea, Jeune Afrique for the Sahel). They are declared on the feed
 * config itself and collected by `getStrategicDefaultSources()` so the
 * bootstrap, cap, and fetch-language paths share one source of truth.
 *
 * A feed can be both locale-boosted AND a strategic default (e.g. a Polish
 * source is boosted for PL users and strategic-default for every locale).
 * The `strategicDefault` flag also makes the feed bypass `filterFeedsByLanguage`
 * so it is fetched regardless of the user's UI language.
 */
export const DEFAULT_ENABLED_SOURCES: Record<string, string[]> = {
  politics: ['BBC World', 'Guardian World', 'AP News', 'Reuters World', 'CNN World'],
  // Canada pack (#5960): CBC News default-on for North America keyCountry CA
  // (public broadcaster, world desk — noise-acceptable on the US-heavy panel).
  // Globe and Mail + Global News remain catalog opt-in.
  us: ['Reuters US', 'NPR News', 'PBS NewsHour', 'ABC News', 'CBS News', 'NBC News', 'Wall Street Journal', 'Politico', 'The Hill', 'CBC News'],
  // Europe defaults — Ukraine war frontline (#5949) + UA/RU balance rule (#5950):
  // ≥1 dedicated UA primary (Kyiv Independent) + ≥1 independent RU (Meduza, Moscow Times).
  // PL frontline: TVN24 + Rzeczpospolita (not all three PL; noise control).
  // TASS/RT never default-on. Extra UA outlets deferred to #5951.
  // HU/EL locale packs remain locale-boosted only, not EN default-on.
  // Eastern flank (#5952): Daily Sabah (EN Turkey) + ERR News (EN Baltic) as
  // default-on; RO/BG/CS feeds stay locale-boosted (lang tags).
  europe: [
    'France 24', 'EuroNews', 'Le Monde', 'DW News', 'Tagesschau', 'ANSA', 'NOS Nieuws', 'SVT Nyheter', 'Balkan Insight',
    ...EASTERN_FLANK_EN_DEFAULT_SOURCES,
    ...FRONTLINE_EUROPE_PROTECTED_SOURCES,
    // Periphery packs (#5953) — Caucasus, Belarus/Moldova
    ...CAUCASUS_EN_DEFAULT_SOURCES,
  ],

  middleeast: ['BBC Middle East', 'Al Jazeera', 'Al Arabiya', 'Guardian ME', 'BBC Persian', 'Iran International', 'IRNA', 'Mehr News', 'Haaretz', 'Jerusalem Post', 'Ynetnews', 'Asharq News', 'The National'],
  africa: [
    'BBC Africa', 'News24', 'Africanews', 'Jeune Afrique', 'Africa News',
    'Premium Times', 'Channels TV', 'Sahel Crisis',
    ...AFRICA_DEPTH_EN_DEFAULT_SOURCES,
  ],
  latam: ['BBC Latin America', 'Reuters LatAm', 'InSight Crime', 'Mexico News Daily', 'Clarín', 'Primicias', 'Infobae Americas', 'El Universo'],
asia: ['BBC Asia', 'The Diplomat', 'South China Morning Post', 'Reuters Asia', 'Nikkei Asia', 'CNA', 'Asia News', 'The Hindu',
    ...CENTRAL_ASIA_EN_DEFAULT_SOURCES,
    ...INDO_PACIFIC_EN_DEFAULT_SOURCES,
  ],
  tech: ['Hacker News', 'Ars Technica', 'The Verge', 'MIT Tech Review'],
  ai: ['AI News', 'VentureBeat AI', 'The Verge AI', 'MIT Tech Review', 'ArXiv AI'],
  finance: ['CNBC', 'MarketWatch', 'Yahoo Finance', 'Financial Times', 'Reuters Business'],
  gov: ['White House', 'State Dept', 'Pentagon', 'UN News', 'CISA', 'Treasury', 'DOJ', 'CDC'],
  layoffs: ['Layoffs.fyi', 'TechCrunch Layoffs', 'Layoffs News'],
  thinktanks: ['Foreign Policy', 'Atlantic Council', 'Foreign Affairs', 'CSIS', 'RAND', 'Brookings', 'Carnegie', 'War on the Rocks', 'ISW'],
  crisis: ['CrisisWatch', 'IAEA', 'WHO', 'UNHCR'],
  energy: ['Oil & Gas', 'Nuclear Energy', 'Reuters Energy', 'Mining & Resources'],
};

export const DEFAULT_ENABLED_INTEL: string[] = [
  'Defense One', 'Breaking Defense', 'The War Zone', 'Defense News',
  'Military Times', 'USNI News', 'Bellingcat', 'Krebs Security',
];

function getExplicitDefaultEnabledSources(): Set<string> {
  const s = new Set<string>();
  for (const names of Object.values(DEFAULT_ENABLED_SOURCES)) names.forEach(n => s.add(n));
  DEFAULT_ENABLED_INTEL.forEach(n => s.add(n));
  return s;
}

export function getAllDefaultEnabledSources(): Set<string> {
  const s = getExplicitDefaultEnabledSources();
  for (const name of getStrategicDefaultSources()) s.add(name);
  return s;
}

/**
 * Sources selected strictly by a non-English language match. Kept separate
 * from strategic-default policy so historical preference migrations can
 * reconstruct pre-rollout locale states deterministically. In particular, an
 * English locale lookup must not implicitly enable every ordinary multi-URL
 * feed that happens to expose an `en` URL.
 */
export function getLanguageMatchedSources(locale: string): Set<string> {
  const lang = (locale.split('-')[0] ?? 'en').toLowerCase();
  const boosted = new Set<string>();
  if (lang === 'en') return boosted;
  const allFeeds = [...Object.values(FULL_FEEDS).flat(), ...INTEL_SOURCES];
  for (const f of allFeeds) {
    if (f.lang === lang) boosted.add(f.name);
    if (typeof f.url === 'object' && lang in f.url) boosted.add(f.name);
  }
  return boosted;
}

/** Sources boosted by locale (feeds tagged with matching `lang` or multi-URL key). */
export function getLocaleBoostedSources(locale: string): Set<string> {
  return getLanguageMatchedSources(locale);
}

export function computeDefaultDisabledSources(locale?: string): string[] {
  const enabled = getAllDefaultEnabledSources();
  if (locale) {
    for (const name of getLocaleBoostedSources(locale)) enabled.add(name);
  }
  const all = new Set<string>();
  for (const feeds of Object.values(FULL_FEEDS)) for (const f of feeds) all.add(f.name);
  for (const f of INTEL_SOURCES) all.add(f.name);
  return [...all].filter(name => !enabled.has(name));
}

/**
 * Sources that were removed from DEFAULT_ENABLED_SOURCES during the regional
 * feed rollout reconciliation (PR #6031). They were historically default-on
 * and must remain in the reconstructed pre-strategic fingerprint so exact-set
 * migration matching finds them in the enabled (not disabled) set.
 */
const PRE_ROLLOUT_RECONCILIATION_DEFAULTS = [
  'Ukrainska Pravda EN',
  'NV EN',
  'NewsMaker',
] as const;

/**
 * Reconstruct the source-reduction defaults from before strategic defaults
 * became part of the canonical default-enabled set. This is used only by the
 * exact-set migrations that repair profiles created before PR #6000.
 */
export function computePreStrategicDefaultDisabledSources(locale?: string): string[] {
  const enabled = getExplicitDefaultEnabledSources();
  for (const name of PRE_ROLLOUT_RECONCILIATION_DEFAULTS) enabled.add(name);
  if (locale) {
    for (const name of getLanguageMatchedSources(locale)) enabled.add(name);
  }
  const all = new Set<string>();
  for (const feeds of Object.values(FULL_FEEDS)) for (const feed of feeds) all.add(feed.name);
  for (const feed of INTEL_SOURCES) all.add(feed.name);
  return [...all].filter((name) => !enabled.has(name));
}

/**
 * Reconstruct the untouched default denylist immediately before PR #5976.
 * Every later regional source is removed because it did not exist in that
 * catalog; the remaining set can be compared exactly without hard-coding a
 * large, brittle list of unrelated feed names.
 */
export function computePreRegionalFeedRolloutDefaultDisabledSources(locale?: string): string[] {
  const introduced = new Set<string>(
    REGIONAL_FEED_ROLLOUT_STAGES.flatMap((stage) => [...stage.introducedNames]),
  );
  return computePreStrategicDefaultDisabledSources(locale)
    .filter((name) => !introduced.has(name));
}

/**
 * The v3 source-reduction migration's pre-#5949 disabled set. This is used
 * only for a conservative one-time frontline migration: an exact match means
 * the profile still has the old untouched defaults, while any extra or
 * missing entry is treated as a user-customized preference and left alone.
 */
export function computeLegacyDefaultDisabledSources(): string[] {
  const disabled = new Set(computePreStrategicDefaultDisabledSources());
  for (const name of FRONTLINE_EUROPE_PROTECTED_SOURCES) disabled.add(name);
  return [...disabled];
}

export function getTotalFeedCount(): number {
  const all = new Set<string>();
  for (const feeds of Object.values(FULL_FEEDS)) for (const f of feeds) all.add(f.name);
  for (const f of INTEL_SOURCES) all.add(f.name);
  return all.size;
}

if (import.meta.env.DEV) {
  const allFeedNames = new Set<string>();
  for (const feeds of Object.values(FULL_FEEDS)) for (const f of feeds) allFeedNames.add(f.name);
  for (const f of INTEL_SOURCES) allFeedNames.add(f.name);
  const defaultEnabled = getAllDefaultEnabledSources();
  for (const name of defaultEnabled) {
    if (!allFeedNames.has(name)) console.error(`[feeds] DEFAULT_ENABLED name "${name}" not found in FULL_FEEDS!`);
  }
  console.log(`[feeds] ${defaultEnabled.size} unique default-enabled sources / ${allFeedNames.size} total`);
}

// Keywords that trigger alert status - must be specific to avoid false positives
export const ALERT_KEYWORDS = [
  'war', 'invasion', 'military', 'nuclear', 'sanctions', 'missile',
  'airstrike', 'drone strike', 'troops deployed', 'armed conflict', 'bombing', 'casualties',
  'ceasefire', 'peace treaty', 'nato', 'coup', 'martial law',
  'assassination', 'terrorist', 'terror attack', 'cyber attack', 'hostage', 'evacuation order',
];

// Patterns that indicate non-alert content (lifestyle, entertainment, etc.)
export const ALERT_EXCLUSIONS = [
  'protein', 'couples', 'relationship', 'dating', 'diet', 'fitness',
  'recipe', 'cooking', 'shopping', 'fashion', 'celebrity', 'movie',
  'tv show', 'sports', 'game', 'concert', 'festival', 'wedding',
  'vacation', 'travel tips', 'life hack', 'self-care', 'wellness',
];
