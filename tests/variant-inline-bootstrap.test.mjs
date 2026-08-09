import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');
const vercelConfig = JSON.parse(readFileSync(resolve(__dirname, '../vercel.json'), 'utf-8'));
const csp = vercelConfig.headers
  .find((entry) => entry.source === '/((?!docs|embed|embed\\.html).*)')
  ?.headers
  ?.find((header) => header.key === 'Content-Security-Policy')
  ?.value ?? '';
const prepaintScript = indexHtml.match(/<script data-wm-prepaint>([\s\S]*?)<\/script>/)?.[1];

describe('single-variant inline prepaint', () => {
  it('does not restore retired host-based variant detection', () => {
    for (const variant of ['happy', 'tech', 'finance', 'commodity', 'energy']) {
      assert.equal(
        indexHtml.includes(`h.startsWith('${variant}.'))v='${variant}'`),
        false,
        `index.html must not restore host sniffing for retired ${variant}.worldmonitor.app`,
      );
    }
    assert.ok(
      prepaintScript?.includes("removeAttribute('data-variant')"),
      'the canonical prepaint must clear stale data-variant state before the app loads',
    );
    assert.equal(
      prepaintScript?.includes('document.documentElement.dataset.variant'),
      false,
      'the prepaint must not assign a runtime variant',
    );
  });

  it('allows the canonical theme/layout prepaint through the CSP', () => {
    assert.ok(prepaintScript, 'index.html must include the inline prepaint script');
    assert.ok(
      prepaintScript.includes('worldmonitor-theme') && prepaintScript.includes('no-transition'),
      'the marked prepaint must retain theme and transition bootstrapping',
    );

    const hash = createHash('sha256').update(prepaintScript).digest('base64');
    assert.ok(
      csp.includes(`'sha256-${hash}'`),
      `Vercel Content-Security-Policy must include sha256-${hash} for the inline prepaint script`,
    );
  });
});
