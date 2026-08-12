import type { VantageSynthesis } from '@/services/vantage-synthesis';
import type { CoverageSurface } from '@/services/vantage-health';
import type { MonitorPulse, MonitorWorkspace } from '@/services/watchlist';

export interface VantageReportInput {
  brief: VantageSynthesis;
  coverage: CoverageSurface[];
  monitor: MonitorWorkspace;
  pulse: MonitorPulse;
  url: string;
  generatedAt?: Date;
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function buildVantageReportMarkdown(input: VantageReportInput): string {
  const { brief, coverage, monitor, pulse } = input;
  const generatedAt = input.generatedAt ?? new Date();
  const scope = [
    ...monitor.countries.map((country) => `country:${country}`),
    ...monitor.topics.map((topic) => `topic:${topic}`),
  ];
  const changeLine = pulse.baselineAt === null
    ? 'No previous review baseline.'
    : `${pulse.newCount} new, ${pulse.strengthenedCount} strengthened, ${pulse.noLongerCurrentCount} no longer current since ${new Date(pulse.baselineAt).toISOString()}.`;
  const lines = [
    '# Vantage situation briefing',
    '',
    `Generated ${generatedAt.toISOString()}`,
    '',
    '## Current assessment',
    '',
    clean(brief.whatChanged),
    '',
    '## Evidence status',
    '',
    clean(brief.whyItMatters),
    '',
  ];
  if (brief.threads.length > 0) {
    lines.push('## Leading threads', '', ...brief.threads.map((thread) => `${thread.index}. ${clean(thread.text)}`), '');
  }
  lines.push(
    '## Monitor',
    '',
    `Name: ${monitor.name}`,
    `Scope: ${scope.length > 0 ? scope.join(', ') : 'No filters; global reporting'}`,
    `Change: ${changeLine}`,
    '',
    '## Coverage',
    '',
    ...coverage.map((surface) => `- ${surface.label}: ${surface.state} — ${surface.detail}`),
    '',
    '## Numbered evidence',
    '',
    ...brief.sources.map((source) => `${source.index}. [${clean(source.title)}](${source.url}) — ${clean(source.source)}`),
    '',
    `Current view: ${input.url}`,
    '',
    `Provenance: ${clean(brief.provenance)}`,
    '',
  );
  return lines.join('\n');
}

export function downloadVantageReport(markdown: string, generatedAt = new Date()): void {
  const day = generatedAt.toISOString().slice(0, 10);
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `vantage-brief-${day}.md`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
