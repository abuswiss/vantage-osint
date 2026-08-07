import type {
  ServerBriefSource,
  ServerInsights,
  ServerInsightStory,
} from '@/services/insights-loader';

export interface VantageEvidenceSource extends ServerBriefSource {
  index: number;
}

export interface VantageSynthesis {
  whatChanged: string;
  whyItMatters: string;
  threads: Array<{ index: number; text: string }>;
  sources: VantageEvidenceSource[];
  generatedAt: string;
  freshness: string;
  confidence: 'HIGH' | 'MEDIUM' | 'DEVELOPING';
  confidenceDetail: string;
  provenance: string;
  degraded: boolean;
  generationMode: 'ai' | 'grounded-fallback';
}

const MAX_SOURCES = 8;
const MAX_THREADS = 5;

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function sourceFromStory(story: ServerInsightStory): ServerBriefSource | null {
  if (!validHttpUrl(story.primaryLink)) return null;
  return {
    title: story.primaryTitle,
    source: story.primarySource,
    url: story.primaryLink,
    ...(story.pubDate ? { publishedAt: story.pubDate } : {}),
  };
}

function relativeFreshness(generatedAt: string, nowMs: number): string {
  const generatedMs = new Date(generatedAt).getTime();
  if (!Number.isFinite(generatedMs)) return 'Freshness unknown';
  const ageMinutes = Math.max(0, Math.round((nowMs - generatedMs) / 60_000));
  if (ageMinutes < 1) return 'Updated just now';
  if (ageMinutes < 60) return `Updated ${ageMinutes}m ago`;
  const hours = Math.round((ageMinutes / 60) * 10) / 10;
  return `Updated ${hours}h ago`;
}

function confidenceFor(stories: ServerInsightStory[]): Pick<VantageSynthesis, 'confidence' | 'confidenceDetail'> {
  const corroborated = stories.filter((story) => story.sourceCount >= 2).length;
  const total = stories.length;
  const ratio = total > 0 ? corroborated / total : 0;
  const confidence: VantageSynthesis['confidence'] = ratio >= 0.6
    ? 'HIGH'
    : ratio >= 0.25
      ? 'MEDIUM'
      : 'DEVELOPING';
  const confidenceDetail = total > 0
    ? `${corroborated} of ${total} lead stories have multi-source corroboration.`
    : 'No lead-story corroboration metadata is available.';
  return { confidence, confidenceDetail };
}

function buildWhyItMatters(insights: ServerInsights): string {
  const stories = insights.topStories;
  const corroborated = stories.filter((story) => story.sourceCount >= 2).length;
  const severe = stories.filter((story) => story.threatLevel === 'critical' || story.threatLevel === 'high').length;
  const categories = [...new Set(stories.map((story) => story.category).filter(Boolean))]
    .slice(0, 3)
    .map((category) => category.replace(/_/g, ' '));

  const evidence = corroborated > 0
    ? `${corroborated} lead ${corroborated === 1 ? 'story is' : 'stories are'} independently corroborated`
    : 'the leading reports are still developing';
  const severity = severe > 0
    ? `, including ${severe} high-severity ${severe === 1 ? 'signal' : 'signals'}`
    : '';
  const breadth = categories.length > 1 ? ` across ${categories.join(', ')}` : '';
  return `This matters because ${evidence}${severity}${breadth}. Treat developing items as signals to verify, not settled facts.`;
}

export function buildVantageSynthesis(
  insights: ServerInsights,
  nowMs = Date.now(),
): VantageSynthesis | null {
  if (!Array.isArray(insights.topStories) || insights.topStories.length === 0) return null;

  const sourceCandidates = insights.worldBriefSources?.length
    ? insights.worldBriefSources
    : insights.topStories.map(sourceFromStory).filter((source): source is ServerBriefSource => source !== null);
  const sources: VantageEvidenceSource[] = [];
  const seenUrls = new Set<string>();
  sourceCandidates.forEach((source, sourceIndex) => {
    if (sources.length >= MAX_SOURCES || !source || !validHttpUrl(source.url) || seenUrls.has(source.url)) return;
    seenUrls.add(source.url);
    sources.push({ ...source, index: sourceIndex + 1 });
  });

  const lines = Array.isArray(insights.briefStoryLines) ? insights.briefStoryLines : [];
  const threadCandidates: Array<{ n: number; text: string }> = lines.length > 0
    ? lines
    : insights.topStories.map((story, index) => ({ n: index + 1, text: `${story.primaryTitle} [${index + 1}]` }));
  const threads = threadCandidates
    .slice(0, MAX_THREADS)
    .map((line) => ({ index: line.n, text: line.text }));

  const whatChanged = insights.worldBrief.trim() || threads[0]?.text || insights.topStories[0]!.primaryTitle;
  const confidence = confidenceFor(insights.topStories);
  const storiesConsidered = insights.provenance?.storiesConsidered ?? insights.clusterCount;
  const sourcesConsidered = insights.provenance?.sourcesConsidered ?? new Set(insights.topStories.map((story) => story.primarySource)).size;

  return {
    whatChanged,
    whyItMatters: buildWhyItMatters(insights),
    threads,
    sources,
    generatedAt: insights.generatedAt,
    freshness: relativeFreshness(insights.generatedAt, nowMs),
    ...confidence,
    provenance: `Compiled from ${storiesConsidered} stories across ${sourcesConsidered} sources.`,
    degraded: insights.status === 'degraded',
    generationMode: insights.briefProvider === 'deterministic-grounded-fallback'
      ? 'grounded-fallback'
      : 'ai',
  };
}
