/**
 * Digest-side companion to tests/dom/rss-empty-title-normalization.test.mts.
 *
 * The server digest parser refuses titleless items, but proto3 strings default
 * to '' and persisted last-good digests from before that gate can replay one.
 * data-loader.ts is too entangled to import in a unit test (Sentry, map, and
 * panel side effects), so this is a source-contract guard in the style of
 * frontend-cii-source-of-truth.test.mts: every digest -> NewsItem mapping must
 * flow through protoItemsToNewsItems, which trims and drops empty titles.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../src/app/data-loader.ts', import.meta.url)),
  'utf8',
);

describe('digest news mapping drops titleless items', () => {
  it('defines the normalizing wrapper with a title guard', () => {
    assert.match(source, /function protoItemsToNewsItems\(/);
    assert.match(source, /\.filter\(item => item\.title\.length > 0\)/);
    assert.match(source, /title: p\.title\.trim\(\)/);
  });

  it('routes every digest mapping through the wrapper', () => {
    // No call site may map protoItemToNewsItem directly over digest items —
    // the only allowed .map is the one inside the wrapper itself.
    const directMaps = source.match(/\.map\(protoItemToNewsItem\)/g) ?? [];
    assert.equal(directMaps.length, 1, 'protoItemToNewsItem mapped outside protoItemsToNewsItems');
    const wrapperCalls = source.match(/protoItemsToNewsItems\(/g) ?? [];
    // Definition plus the two digest branches (category + intel).
    assert.ok(
      wrapperCalls.length >= 3,
      `expected >=3 occurrences (definition + 2 call sites), saw ${wrapperCalls.length}`,
    );
  });
});
