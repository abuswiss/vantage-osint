/**
 * Shared confidence parsing + badge for AI analysis surfaces
 * (ChatAnalystPanel '### Confidence' sections, DeductionPanel confidence
 * sections). Parsing is deliberately lenient: any heading-ish line that
 * starts with "confidence" is scanned — along with the next two lines —
 * for a level word.
 */

export type ConfidenceLevel = 'high' | 'moderate' | 'low';

const CONFIDENCE_HEADING_RE = /^\s*(?:#{1,6}\s*|\*\*\s*)?confidence\b/i;
const LEVEL_WORD_RE = /\b(high|moderate|medium|low)\b/i;

/** First high/moderate/medium/low word in a blob of text (medium → moderate). */
export function matchConfidenceWord(text: string): ConfidenceLevel | null {
  const match = LEVEL_WORD_RE.exec(text);
  if (!match) return null;
  const word = (match[1] ?? '').toLowerCase();
  if (word === 'medium') return 'moderate';
  return word as ConfidenceLevel;
}

/** Find a confidence section in raw markdown and extract its level. */
export function extractConfidenceLevel(markdown: string): ConfidenceLevel | null {
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!CONFIDENCE_HEADING_RE.test(line)) continue;
    const scope = [line, lines[i + 1] ?? '', lines[i + 2] ?? ''].join(' ');
    return matchConfidenceWord(scope);
  }
  return null;
}

const LEVEL_LABELS: Record<ConfidenceLevel, string> = {
  high: 'High',
  moderate: 'Moderate',
  low: 'Low',
};

/** Small tinted badge reflecting an analysis confidence level. */
export function createConfidenceBadge(level: ConfidenceLevel): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.className = 'wm-confidence-badge';
  badge.dataset.level = level;
  badge.textContent = LEVEL_LABELS[level];
  badge.title = `Analyst confidence: ${LEVEL_LABELS[level].toLowerCase()}`;
  return badge;
}
