import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/vantage-intelligence-refresh.yml', import.meta.url),
  'utf8',
);

describe('Vantage intelligence refresh workflow', () => {
  it('bypasses the public CDN when warming the short-lived Redis digest', () => {
    assert.match(workflow, /--header 'Cache-Control: no-cache'/);
    assert.match(workflow, /public=1&refresh=\$\{GITHUB_RUN_ID\}/);
  });

  it('rejects a stale fallback response even when it still has categories', () => {
    assert.match(workflow, /Date\.parse\(d\.generatedAt\)/);
    assert.match(workflow, /age > 300000/);
  });
});
