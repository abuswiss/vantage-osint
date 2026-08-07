import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  diffBriefSnapshots,
  extractBriefLines,
  headlineFromBrief,
} = await import('./brief-history.js');

function snapshot(generatedAt, lines, worldBrief = '') {
  return {
    generatedAt,
    worldBrief,
    ...(lines ? { briefStoryLines: lines.map((text, i) => ({ n: i + 1, text })) } : {}),
  };
}

describe('Brief history diff', () => {
  it('marks every line kept and unchanged for identical snapshots', () => {
    const lines = [
      'Russia strikes Kyiv energy grid overnight [1].',
      'Markets slide after surprise Fed guidance [2].',
      'Typhoon nears Taiwan as evacuations begin [3].',
    ];
    const diff = diffBriefSnapshots(
      snapshot('2026-08-06T12:00:00.000Z', lines),
      snapshot('2026-08-07T12:00:00.000Z', lines),
    );

    assert.deepEqual(diff.a, { generatedAt: '2026-08-06T12:00:00.000Z' });
    assert.deepEqual(diff.b, { generatedAt: '2026-08-07T12:00:00.000Z' });
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
    assert.equal(diff.kept.length, lines.length);
    assert.ok(diff.kept.every((line) => line.changed === false));
    assert.deepEqual(diff.kept.map((line) => line.text), lines);
  });

  it('reports disjoint snapshots as pure added plus removed', () => {
    const diff = diffBriefSnapshots(
      snapshot('2026-08-06T12:00:00.000Z', [
        'Ceasefire talks resume in Cairo [1].',
        'Oil prices spike on shipping lane closure [2].',
      ]),
      snapshot('2026-08-07T12:00:00.000Z', [
        'Volcano erupts in Iceland forcing airport shutdown [1].',
        'New sanctions target semiconductor exports [2].',
      ]),
    );

    assert.deepEqual(diff.kept, []);
    assert.deepEqual(diff.added, [
      'Volcano erupts in Iceland forcing airport shutdown [1].',
      'New sanctions target semiconductor exports [2].',
    ]);
    assert.deepEqual(diff.removed, [
      'Ceasefire talks resume in Cairo [1].',
      'Oil prices spike on shipping lane closure [2].',
    ]);
  });

  it('matches lines whose only difference is citation indexes and case', () => {
    const diff = diffBriefSnapshots(
      snapshot('2026-08-06T12:00:00.000Z', ['Russia strikes Kyiv energy grid overnight [3].']),
      snapshot('2026-08-07T12:00:00.000Z', ['russia strikes Kyiv energy grid overnight [7].']),
    );

    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
    assert.equal(diff.kept.length, 1);
    assert.equal(diff.kept[0].changed, false);
  });

  it('flags a kept line as changed when its wording actually moved', () => {
    const diff = diffBriefSnapshots(
      snapshot('2026-08-06T12:00:00.000Z', ['Typhoon nears Taiwan as evacuations begin [1].']),
      snapshot('2026-08-07T12:00:00.000Z', ['Typhoon makes landfall in Taiwan as evacuations begin [1].']),
    );

    assert.equal(diff.kept.length, 1);
    assert.equal(diff.kept[0].changed, true);
    assert.equal(diff.kept[0].previousText, 'Typhoon nears Taiwan as evacuations begin [1].');
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
  });

  it('falls back to sentence-splitting worldBrief when briefStoryLines is missing', () => {
    const legacy = snapshot(
      '2026-08-06T12:00:00.000Z',
      null,
      'Ceasefire talks resume in Cairo [1]. Oil prices spike on shipping lane closure [2].',
    );
    assert.deepEqual(extractBriefLines(legacy), [
      'Ceasefire talks resume in Cairo [1].',
      'Oil prices spike on shipping lane closure [2].',
    ]);

    const diff = diffBriefSnapshots(
      legacy,
      snapshot('2026-08-07T12:00:00.000Z', ['Ceasefire talks resume in Cairo [4].']),
    );
    assert.equal(diff.kept.length, 1);
    assert.equal(diff.kept[0].changed, false);
    assert.deepEqual(diff.removed, ['Oil prices spike on shipping lane closure [2].']);
    assert.deepEqual(diff.added, []);
  });
});

describe('Brief history headline', () => {
  it('takes the first sentence and strips citation markers', () => {
    assert.equal(
      headlineFromBrief('Markets slide after Fed guidance [1][2]. A second sentence follows.'),
      'Markets slide after Fed guidance.',
    );
  });

  it('caps the headline at 140 characters', () => {
    const headline = headlineFromBrief(`${'word '.repeat(60)}end.`);
    assert.ok(headline.length <= 140);
    assert.ok(headline.endsWith('…'));
  });
});
