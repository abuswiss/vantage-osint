/**
 * Regression: /country/:slug deep links silently fell through to a generic
 * dashboard because nothing resolved the slug. resolveCountrySlug() must cover
 * every slug the prebuilt SEO pages actually ship (public/countries/<slug>/),
 * since those are the URLs in the wild.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { resolveCountrySlug, slugifyCountryName } from '../src/utils/country-slug.ts';
import { loadCorpusData } from '../scripts/build-crawlable-corpus.mjs';

describe('resolveCountrySlug', () => {
  it('resolves every shipped SEO country slug to an ISO2 code', async () => {
    // public/countries is generated and intentionally gitignored, so derive
    // the routes from the same committed corpus inputs the production build
    // uses instead of depending on a previous local build artifact.
    const corpus = await loadCorpusData();
    const slugs = corpus.countries.map((country) => country.slug);
    assert.ok(slugs.length > 100, `expected the prebuilt country pages, saw ${slugs.length}`);
    const unresolved = slugs.filter((slug) => !/^[A-Z]{2}$/.test(resolveCountrySlug(slug) ?? ''));
    assert.deepEqual(unresolved, []);
  });

  it('resolves representative slugs to the expected codes', () => {
    assert.equal(resolveCountrySlug('ukraine'), 'UA');
    assert.equal(resolveCountrySlug('united-states'), 'US');
    assert.equal(resolveCountrySlug('cote-divoire'), 'CI');
  });

  it('accepts bare ISO2 codes and URL-encoded input', () => {
    assert.equal(resolveCountrySlug('ua'), 'UA');
    assert.equal(resolveCountrySlug('DE'), 'DE');
    assert.equal(resolveCountrySlug('c%C3%B4te-d%27ivoire'), 'CI');
  });

  it('honors the uniqueSlug ISO2 dedupe suffix', () => {
    // corpus uniqueSlug() appends "-<code>" on name collisions.
    assert.equal(resolveCountrySlug('some-unknown-name-cd'), 'CD');
  });

  it('returns null for unknown or malformed slugs', () => {
    assert.equal(resolveCountrySlug('atlantis'), null);
    assert.equal(resolveCountrySlug(''), null);
    assert.equal(resolveCountrySlug('../../etc/passwd'), null);
  });

  it('slugify matches the corpus builder transform', () => {
    assert.equal(slugifyCountryName("Côte d'Ivoire & Friends"), 'cote-d-ivoire-and-friends');
    assert.equal(slugifyCountryName('  Bosnia and Herzegovina '), 'bosnia-and-herzegovina');
  });
});
