import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/vantage-intelligence-refresh.yml', import.meta.url),
  'utf8',
);

describe('Vantage intelligence refresh workflow', () => {
  it('refreshes more often than the ten-minute news freshness window', () => {
    assert.match(workflow, /cron: "\*\/5 \* \* \* \*"/);
  });

  it('bypasses the public CDN and proves the origin recomputed the digest', () => {
    assert.match(workflow, /--header 'Cache-Control: no-cache'/);
    assert.match(workflow, /--header "X-WorldMonitor-Key: \$WORLDMONITOR_RELAY_KEY"/);
    assert.match(workflow, /public=1&refresh=\$\{GITHUB_RUN_ID\}/);
    assert.match(workflow, /started_at=/);
    assert.match(workflow, /generated < started-5000/);
  });

  it('rejects a stale fallback response even when it still has categories', () => {
    assert.match(workflow, /Date\.parse\(d\.generatedAt\)/);
    assert.match(workflow, /age > 300000/);
  });

  it('retries until this run publishes a citation-valid AI brief', () => {
    assert.doesNotMatch(workflow, /\\`/);
    assert.match(workflow, /brief_started_at=/);
    assert.match(workflow, /get\/\$\{encodeURIComponent\('news:insights:v1'\)\}/);
    assert.match(workflow, /stored\?\.data \?\? stored/);
    assert.match(workflow, /payload\?\.status !== 'ok'/);
    assert.match(workflow, /generated < started - 5_000/);
  });
});
