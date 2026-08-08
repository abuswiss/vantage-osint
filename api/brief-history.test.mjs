import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  diffBriefSnapshots,
  extractBriefLines,
  handleBriefHistoryRequest,
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

describe('Brief history HTTP boundary', () => {
  const request = (path = '', method = 'GET') => new Request(`https://vantage.example/api/brief-history${path}`, { method });
  const allow = async () => null;

  it('handles preflight and rejects unsupported methods without touching Redis', async () => {
    const untouched = async () => { throw new Error('dependency should not be called'); };
    const options = await handleBriefHistoryRequest(request('', 'OPTIONS'), {}, {
      pipeline: untouched,
      checkRateLimit: untouched,
    });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('access-control-allow-origin'), '*');

    const post = await handleBriefHistoryRequest(request('', 'POST'), {}, {
      pipeline: untouched,
      checkRateLimit: untouched,
    });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('cache-control'), 'no-store');
  });

  it('rejects malformed and oversized selectors before rate-limit or archive I/O', async () => {
    let calls = 0;
    const untouched = async () => { calls += 1; return null; };
    const malformed = await handleBriefHistoryRequest(request('?diff=not-a-date,latest'), {}, {
      pipeline: untouched,
      checkRateLimit: untouched,
    });
    assert.equal(malformed.status, 400);

    const oversized = await handleBriefHistoryRequest(request(`?diff=${'x'.repeat(181)}`), {}, {
      pipeline: untouched,
      checkRateLimit: untouched,
    });
    assert.equal(oversized.status, 400);
    assert.equal(calls, 0);
  });

  it('bounds archive reads, applies scoped rate limiting, and emits cache headers', async () => {
    const older = snapshot('2026-08-06T12:00:00.000Z', ['Earlier report [1].']);
    const latest = snapshot('2026-08-07T12:00:00.000Z', ['Current report [1].']);
    const commands = [];
    const response = await handleBriefHistoryRequest(request('?diff=yesterday,latest'), {}, {
      checkRateLimit: allow,
      pipeline: async (next) => {
        commands.push(...next);
        return [{ result: [
          JSON.stringify(older), String(Date.parse(older.generatedAt)),
          JSON.stringify(latest), String(Date.parse(latest.generatedAt)),
        ] }];
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, s-maxage=60, stale-while-revalidate=300');
    assert.deepEqual(commands, [[
      'ZRANGE', 'news:insights:history:v1', '-400', '-1', 'WITHSCORES',
    ]]);
  });

  it('returns a limiter response without reading the archive', async () => {
    let pipelineCalls = 0;
    const response = await handleBriefHistoryRequest(request(), {}, {
      pipeline: async () => { pipelineCalls += 1; return []; },
      checkRateLimit: async (_req, _headers, options) => {
        assert.deepEqual({ scope: options.scope, limit: options.limit, window: options.window }, {
          scope: 'brief-history', limit: 120, window: '60 s',
        });
        return new Response('limited', { status: 429 });
      },
    });
    assert.equal(response.status, 429);
    assert.equal(pipelineCalls, 0);
  });

  it('fails closed at the history boundary when Redis is unavailable', async () => {
    const response = await handleBriefHistoryRequest(request(), {}, {
      checkRateLimit: allow,
      pipeline: async () => null,
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});
