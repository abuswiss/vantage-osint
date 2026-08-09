/**
 * Defensive-rendering companion to rss-empty-title-normalization.test.mts:
 * ingestion drops titleless items, but persisted caches written by earlier
 * builds can still replay one. The OpsShell feed row and inspector heading
 * must render a labelled placeholder, never a blank node (the inspector title
 * is the dialog's aria-labelledby target).
 */
import { describe, expect, it } from 'vitest';

import { feedDisplayTitle } from '@/app/ops-shell';

describe('feedDisplayTitle', () => {
  it('passes real titles through unchanged', () => {
    expect(feedDisplayTitle({ title: 'Ceasefire talks resume' })).toBe('Ceasefire talks resume');
  });

  it('labels empty and whitespace-only titles', () => {
    expect(feedDisplayTitle({ title: '' })).toBe('Untitled intelligence item');
    expect(feedDisplayTitle({ title: '   ' })).toBe('Untitled intelligence item');
  });
});
