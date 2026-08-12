import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildVantageReportMarkdown } from '../src/services/vantage-report';

describe('Vantage Markdown handoff', () => {
  it('exports the brief, monitor change, coverage, deep link, and numbered evidence', () => {
    const markdown = buildVantageReportMarkdown({
      brief: {
        whatChanged: 'A cited development moved [1].',
        whyItMatters: 'The report is independently supported.',
        threads: [{ index: 1, text: 'The leading thread [1].' }],
        sources: [{ index: 1, title: 'Source report', source: 'Reuters', url: 'https://example.com/report' }],
        generatedAt: '2026-08-12T09:00:00.000Z',
        freshness: 'Updated 5m ago',
        confidence: 'HIGH',
        confidenceDetail: '1 of 1 lead stories are reported by multiple named outlets.',
        provenance: 'Compiled from 10 stories across 4 named feeds.',
        degraded: false,
        generationMode: 'ai',
      },
      coverage: [{
        id: 'reports', label: 'Reports', state: 'current',
        detail: 'The report feed was refreshed 1m ago.', ageSeconds: 60,
      }],
      monitor: {
        id: 'monitor-one', name: 'Energy desk', countries: ['UA'], topics: ['oil'],
        createdAt: 1, updatedAt: 2, baseline: null,
      },
      pulse: { baselineAt: 1_000, newCount: 2, strengthenedCount: 1, noLongerCurrentCount: 3 },
      url: 'https://vantage.example/?timeRange=24h',
      generatedAt: new Date('2026-08-12T10:00:00.000Z'),
    });

    assert.match(markdown, /^# Vantage situation briefing/m);
    assert.match(markdown, /Name: Energy desk/);
    assert.match(markdown, /2 new, 1 strengthened, 3 no longer current/);
    assert.match(markdown, /Reports: current/);
    assert.match(markdown, /1\. \[Source report\]\(https:\/\/example\.com\/report\) — Reuters/);
    assert.match(markdown, /Current view: https:\/\/vantage\.example\/\?timeRange=24h/);
  });
});
