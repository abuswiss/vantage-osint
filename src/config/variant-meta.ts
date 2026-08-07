import { BRAND } from './brand';

export interface VariantMeta {
  title: string;
  description: string;
  keywords: string;
  url: string;
  siteName: string;
  shortName: string;
  subject: string;
  classification: string;
  categories: string[];
  features: string[];
}

export const VARIANT_META: { full: VariantMeta; [k: string]: VariantMeta } = {
  full: {
    title: `${BRAND.name} - ${BRAND.tagline}`,
    description: 'Real-time global intelligence platform tracking conflicts, markets, military activity, and OSINT signals across 190+ countries, with live context in one view.',
    keywords: 'AI intelligence, AI-powered dashboard, global intelligence, geopolitical dashboard, world news, market data, military bases, nuclear facilities, undersea cables, conflict zones, real-time monitoring, situation awareness, OSINT, flight tracking, AIS ships, earthquake monitor, protest tracker, power outages, oil prices, government spending, polymarket predictions',
    url: 'https://www.worldmonitor.app/dashboard',
    siteName: BRAND.name,
    shortName: BRAND.shortName,
    subject: 'AI-Powered Global Intelligence and Situation Awareness',
    classification: 'AI Intelligence Dashboard, OSINT Tool, News Aggregator',
    categories: ['news', 'productivity'],
    features: [
      'Real-time news aggregation',
      'Stock market tracking',
      'Military flight monitoring',
      'Ship AIS tracking',
      'Earthquake alerts',
      'Protest tracking',
      'Power outage monitoring',
      'Oil price analytics',
      'Government spending data',
      'Prediction markets',
      'Infrastructure monitoring',
      'Geopolitical intelligence',
    ],
  },
};

/**
 * Public metadata for the Vantage fork. Keep this beside the upstream variant
 * metadata so source index.html, Vite's HTML transform, and the PWA manifest
 * all share one contract.
 */
export const VANTAGE_PUBLIC_META: VariantMeta = {
  ...VARIANT_META.full,
  title: 'Vantage - Real-Time Global Intelligence Dashboard',
  description: 'Open-source global intelligence with live news, map signals, risk context, and citation-backed AI synthesis in one public view.',
  url: 'https://vantage-osint.vercel.app/',
  siteName: 'Vantage',
  shortName: 'Vantage',
};
