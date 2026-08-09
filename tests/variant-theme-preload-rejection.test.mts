import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * WORLDMONITOR-XT (2026-07-28) pinned that the happy variant stylesheet import
 * consumed its own preload rejection. With the single-variant strip, the happy
 * theme and its guarded loader are gone entirely — this file now pins that the
 * variant-theme machinery does not come back, and that no bare fire-and-forget
 * stylesheet import (the original leak shape) is reintroduced in main.ts.
 */

const mainSource = readFileSync(
  fileURLToPath(new URL('../src/main.ts', import.meta.url)),
  'utf8',
);

describe('main.ts variant stylesheet call site (single-variant)', () => {
  it('carries no variant theme loader call', () => {
    assert.ok(
      !mainSource.includes('loadVariantThemeStylesheet'),
      'main.ts must not load variant theme stylesheets after the single-variant strip',
    );
    assert.ok(
      !mainSource.includes('happy-theme'),
      'main.ts must not reference the removed happy theme',
    );
  });

  it('has no bare fire-and-forget stylesheet import (WORLDMONITOR-XT shape)', () => {
    const bareThemeImports = mainSource.match(/void import\(['"]\.\/styles\/[\w-]+\.css['"]\)/g) ?? [];
    assert.deepEqual(
      bareThemeImports,
      [],
      'a bare `void import(<theme>.css)` discards the preload rejection — never reintroduce it',
    );
  });

  it('the variant theme module and stylesheet are gone from the tree', () => {
    assert.equal(
      existsSync(fileURLToPath(new URL('../src/bootstrap/variant-theme.ts', import.meta.url))),
      false,
      'src/bootstrap/variant-theme.ts should stay deleted',
    );
    assert.equal(
      existsSync(fileURLToPath(new URL('../src/styles/happy-theme.css', import.meta.url))),
      false,
      'src/styles/happy-theme.css should stay deleted',
    );
  });
});
