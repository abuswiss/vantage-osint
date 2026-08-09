/**
 * Regression: OpsShell/Vantage feed rendered blank rows because the client RSS
 * parser minted NewsItems from <item> nodes with a missing, empty, or
 * whitespace-only <title>. The canonical fix drops those items at the parse
 * boundary (src/services/rss.ts), mirroring the server digest parser rule in
 * server/worldmonitor/news/v1/list-feed-digest.ts.
 *
 * Runs in the DOM project: rss.ts needs DOMParser and transitively imports
 * @/services/i18n (import.meta.glob), which the tsx test runner cannot load.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchFeed } from '@/services/rss';

const RSS_WITH_BLANK_TITLES = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Fixture Wire</title>
    <item>
      <title>Ceasefire talks resume in Geneva</title>
      <link>https://example.com/a</link>
      <pubDate>Fri, 07 Aug 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title></title>
      <link>https://example.com/empty</link>
      <pubDate>Fri, 07 Aug 2026 11:00:00 GMT</pubDate>
    </item>
    <item>
      <title>   </title>
      <link>https://example.com/whitespace</link>
      <pubDate>Fri, 07 Aug 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <link>https://example.com/missing</link>
      <pubDate>Fri, 07 Aug 2026 13:00:00 GMT</pubDate>
    </item>
    <item>
      <title>  Grid restored after storm outage  </title>
      <link>https://example.com/b</link>
      <pubDate>Fri, 07 Aug 2026 14:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

describe('client RSS parse drops titleless items', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps only items with a non-blank trimmed title', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(RSS_WITH_BLANK_TITLES, {
      status: 200,
      headers: { 'content-type': 'application/rss+xml' },
    })));

    const items = await fetchFeed({ name: 'Fixture Wire', url: 'https://example.com/rss', category: 'geopolitics' } as never);

    expect(items.map((item) => item.title)).toEqual([
      'Ceasefire talks resume in Geneva',
      'Grid restored after storm outage',
    ]);
    // The drop happens at ingestion, not render: no NewsItem with a blank
    // title may survive into the feed cache/clustering inputs.
    expect(items.every((item) => item.title.trim().length > 0)).toBe(true);
  });
});
