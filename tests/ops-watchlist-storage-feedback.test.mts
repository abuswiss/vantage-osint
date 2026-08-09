import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const shell = readFileSync(new URL('../src/app/ops-shell.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles/ops-shell.css', import.meta.url), 'utf8');

describe('OpsShell watchlist persistence feedback', () => {
  it('announces storage or capacity failures beside the add form', () => {
    assert.match(shell, /feedback\.setAttribute\('role', 'status'\)/);
    assert.match(shell, /feedback\.setAttribute\('aria-live', 'polite'\)/);
    assert.match(shell, /if \(!toggleCountry\(value\)\)/);
    assert.match(shell, /if \(!toggleTopic\(value\)\)/);
    assert.match(shell, /The list may be full or browser storage unavailable/);
    assert.match(css, /\.ops-watch-add-input\[aria-invalid='true'\]/);
    assert.match(css, /\.ops-watch-feedback\s*\{/);
  });

  it('only requests notification permission after the enabled preference persisted', () => {
    assert.match(shell, /const persisted = getAlertPrefs\(\)\.enabled/);
    assert.match(shell, /if \(persisted !== requested\)/);
    assert.match(shell, /if \(persisted && supported && Notification\.permission === 'default'\)/);
  });

  it('restores the persisted threshold when a preference write fails', () => {
    assert.match(shell, /const persisted = getAlertPrefs\(\)\.escalationThreshold/);
    assert.match(shell, /threshold\.value = String\(persisted\)/);
  });
});
