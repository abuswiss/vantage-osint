import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ServerInsights } from '../src/services/insights-loader';
import { buildVantageSynthesis } from '../src/services/vantage-synthesis';

function makeInsights(): ServerInsights {
  return {
    worldBrief: 'Two independently reported security developments are moving in parallel [1][3].',
    briefStoryLines: [
      { n: 1, text: 'A first verified development was reported [1].' },
      { n: 2, text: 'A developing single-source report remains under review [2].' },
      { n: 3, text: 'A second corroborated development was reported [3].' },
    ],
    worldBriefSources: [
      { title: 'First report', source: 'Reuters', url: 'https://example.com/one' },
      { title: 'Unsafe report', source: 'Unknown', url: 'javascript:alert(1)' },
      { title: 'Third report', source: 'BBC', url: 'https://example.com/three' },
    ],
    briefProvider: 'openai',
    status: 'ok',
    topStories: [
      {
        primaryTitle: 'First report', primarySource: 'Reuters', primaryLink: 'https://example.com/one',
        pubDate: '2026-08-07T10:00:00.000Z', sourceCount: 3, importanceScore: 90,
        velocity: { level: 'normal', sourcesPerHour: 0 }, isAlert: true,
        category: 'conflict', threatLevel: 'high', countryCode: 'TH',
      },
      {
        primaryTitle: 'Second report', primarySource: 'Local', primaryLink: 'https://example.com/two',
        pubDate: '2026-08-07T10:01:00.000Z', sourceCount: 1, importanceScore: 70,
        velocity: { level: 'normal', sourcesPerHour: 0 }, isAlert: false,
        category: 'political', threatLevel: 'moderate', countryCode: null,
      },
      {
        primaryTitle: 'Third report', primarySource: 'BBC', primaryLink: 'https://example.com/three',
        pubDate: '2026-08-07T10:02:00.000Z', sourceCount: 2, importanceScore: 80,
        velocity: { level: 'normal', sourcesPerHour: 0 }, isAlert: true,
        category: 'geopolitical', threatLevel: 'critical', countryCode: null,
      },
    ],
    generatedAt: '2026-08-07T10:05:00.000Z',
    clusterCount: 12,
    multiSourceCount: 7,
    fastMovingCount: 2,
    provenance: { storiesConsidered: 282, sourcesConsidered: 74 },
  };
}

describe('Vantage cited synthesis view model', () => {
  it('builds a compact evidence-backed brief without exposing provider details', () => {
    const brief = buildVantageSynthesis(makeInsights(), Date.parse('2026-08-07T10:10:00.000Z'));

    assert.ok(brief);
    assert.equal(brief.confidence, 'HIGH');
    assert.equal(brief.freshness, 'Updated 5m ago');
    assert.match(brief.whyItMatters, /2 lead stories are independently corroborated/);
    assert.match(brief.provenance, /282 stories across 74 sources/);
    assert.deepEqual(brief.sources.map((source) => source.index), [1, 3]);
    assert.equal(brief.sources.some((source) => source.url.startsWith('javascript:')), false);
    assert.equal('briefProvider' in brief, false);
    assert.equal(brief.generationMode, 'ai');
  });

  it('identifies the grounded safety fallback without exposing provider details', () => {
    const input = makeInsights();
    input.briefProvider = 'deterministic-grounded-fallback';

    const brief = buildVantageSynthesis(input);

    assert.ok(brief);
    assert.equal(brief.generationMode, 'grounded-fallback');
    assert.equal('briefProvider' in brief, false);
  });

  it('does not label a provider headline fallback as model synthesis', () => {
    const input = makeInsights();
    input.briefProvider = 'openai+headline-fallback';
    const brief = buildVantageSynthesis(input, Date.parse('2026-08-07T10:10:00.000Z'));
    assert.equal(brief?.generationMode, 'grounded-fallback');
  });

  it('falls back to cited headlines when per-story synthesis lines are absent', () => {
    const input = makeInsights();
    delete input.briefStoryLines;
    input.worldBrief = '';
    const brief = buildVantageSynthesis(input);

    assert.ok(brief);
    assert.equal(brief.whatChanged, 'First report [1]');
    assert.equal(brief.threads[0]?.index, 1);
  });

  it('rejects an empty insight snapshot', () => {
    const input = makeInsights();
    input.topStories = [];
    assert.equal(buildVantageSynthesis(input), null);
  });
});
