import { expect, test, type Page } from '@playwright/test';

const TEST_HEADLINE = 'Vantage E2E verified intelligence report';
const TEST_LINK = 'https://example.com/vantage-e2e-report';
const TEST_SECOND_LINK = 'https://example.com/vantage-e2e-second-report';

async function installDeterministicNews(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
  });

  await page.route('**/api/news/v1/list-feed-digest*', async (route) => {
    const item = {
      source: 'BBC World',
      title: TEST_HEADLINE,
      link: TEST_LINK,
      publishedAt: Date.now(),
      isAlert: false,
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        categories: {
          politics: { items: [item] },
          intel: { items: [] },
        },
        feedStatuses: {},
        generatedAt: new Date().toISOString(),
      }),
    });
  });

  await page.route('**/api/bootstrap?tier=fast&public=1*', async (route) => {
    const now = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          insights: {
            worldBrief: 'A verified security report and a second corroborated development are moving in parallel [1][2].',
            briefStoryLines: [
              { n: 1, text: 'The verified intelligence report is active [1].' },
              { n: 2, text: 'A second corroborated development is active [2].' },
            ],
            worldBriefSources: [
              { title: TEST_HEADLINE, source: 'BBC World', url: TEST_LINK, publishedAt: now },
              { title: 'Second corroborated development', source: 'Reuters', url: TEST_SECOND_LINK, publishedAt: now },
            ],
            briefProvider: 'openai',
            status: 'ok',
            topStories: [
              {
                primaryTitle: TEST_HEADLINE, primarySource: 'BBC World', primaryLink: TEST_LINK,
                pubDate: now, sourceCount: 3, importanceScore: 90,
                velocity: { level: 'normal', sourcesPerHour: 0 }, isAlert: true,
                category: 'conflict', threatLevel: 'high', countryCode: null,
              },
              {
                primaryTitle: 'Second corroborated development', primarySource: 'Reuters', primaryLink: TEST_SECOND_LINK,
                pubDate: now, sourceCount: 2, importanceScore: 80,
                velocity: { level: 'normal', sourcesPerHour: 0 }, isAlert: false,
                category: 'geopolitical', threatLevel: 'moderate', countryCode: null,
              },
            ],
            generatedAt: now,
            clusterCount: 12,
            multiSourceCount: 7,
            fastMovingCount: 1,
            provenance: { storiesConsidered: 282, sourcesConsidered: 74 },
          },
        },
        missing: [],
      }),
    });
  });
}

async function openOpsShell(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.ops-shell')).toBeVisible();
  await page.waitForFunction(() => document.documentElement.dataset.wmEventHandlersReady === 'true');
  await expect(page.locator('.ops-feed-item').filter({ hasText: TEST_HEADLINE })).toBeVisible();
}

test.describe('Vantage operations shell', () => {
  test.beforeEach(async ({ page }) => {
    await installDeterministicNews(page);
  });

  test('supports the complete map-first investigation workflow', async ({ page }) => {
    const unprovisionedRequests: string[] = [];
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (/\/(?:telegram-feed|gpsjam|oref-alerts)$/.test(pathname)
        || /\/(?:list-military-flights|list-military-vessels)$/.test(pathname)) {
        unprovisionedRequests.push(pathname);
      }
    });
    await openOpsShell(page);

    await expect(page).toHaveTitle('Vantage — Real-Time Global Intelligence Dashboard');
    await expect(page.locator('.ops-brand')).toContainText('Vantage');
    await expect(page.locator('.ops-timeline-bar')).toHaveCount(32);
    await expect(page.locator('.auth-header-widget')).toHaveCount(0);
    await expect(page.locator('.pro-banner')).toHaveCount(0);
    await expect(page.locator('#authWidgetMount')).toBeEmpty();
    await expect(page.locator('#mobileAuthFallback')).toHaveCount(0);
    await expect(page.locator('.mobile-menu-account')).toHaveCount(0);
    await expect(page.locator('.mobile-menu-variant')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Air layer pending relay provisioning' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Ships layer pending relay provisioning' })).toBeDisabled();
    await expect(page.locator('.ops-status-item')).toContainText('AIR/SHIPS PENDING');
    const bottomLabelLayout = await page.evaluate(() => {
      const status = document.querySelector<HTMLElement>('.ops-status-item');
      const activity = document.querySelector<HTMLElement>('.ops-timeline-label');
      const text = status?.firstChild;
      if (!status || !activity || !text) throw new Error('missing operations-shell bottom labels');
      const range = document.createRange();
      range.selectNodeContents(text);
      return {
        statusTextRight: range.getBoundingClientRect().right,
        activityLeft: activity.getBoundingClientRect().left,
      };
    });
    expect(bottomLabelLayout.statusTextRight).toBeLessThan(bottomLabelLayout.activityLeft);
    expect(unprovisionedRequests).toEqual([]);

    await page.getByRole('button', { name: 'Open cited AI situation brief' }).click();
    await expect(page.locator('#opsInspector')).toBeVisible();
    await expect(page.locator('.ops-inspector-title')).toHaveText('Global situation brief');
    await expect(page.locator('#opsInspector')).toContainText('WHAT CHANGED');
    await expect(page.locator('#opsInspector')).toContainText('WHY IT MATTERS');
    await expect(page.locator('#opsInspector')).toContainText('Compiled from 282 stories across 74 sources.');
    await expect(page.locator('.ops-source-link')).toHaveCount(2);
    await expect(page.locator('.ops-source-link').first()).toHaveAttribute('href', TEST_LINK);
    await page.getByRole('button', { name: 'Close inspector' }).click();

    const oneHour = page.getByRole('button', { name: 'Show the last 1h activity' });
    await oneHour.click();
    await expect(oneHour).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => new URL(page.url()).searchParams.get('timeRange')).toBe('1h');

    await page.locator('.ops-more-layers').click();
    await expect(page.getByRole('dialog', { name: 'Map layers' })).toBeVisible();
    await expect(page.locator('.ops-layer-option')).toHaveCount(32);
    await expect(page.locator('.ops-layer-option', { hasText: 'Resilience' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Map layers' })).toBeHidden();

    await page.keyboard.press('j');
    await expect(page.locator('.ops-feed-item').first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#opsInspector')).toBeVisible();
    await expect(page.locator('.ops-inspector-title')).toHaveText(TEST_HEADLINE);
    await expect(page.locator('.ops-source-link')).toHaveAttribute('href', TEST_LINK);
    await expect.poll(() => new URL(page.url()).searchParams.get('focus')).not.toBeNull();

    await page.getByRole('button', { name: 'Close inspector' }).click();
    await expect(page.locator('#opsInspector')).toBeHidden();
    expect(new URL(page.url()).searchParams.has('focus')).toBe(false);

    await page.keyboard.press('/');
    const search = page.locator('.search-overlay');
    await expect(search).toBeVisible();
    await expect(search).toContainText('VANTAGE // INTELLIGENCE COMMAND DECK');
    await search.locator('.search-input').fill('Vantage E2E verified');
    const searchResult = search.locator('.search-result-item').filter({ hasText: TEST_HEADLINE });
    await expect(searchResult).toBeVisible();
    await searchResult.click();
    await expect(search).toHaveCount(0);
    await expect(page.locator('#opsInspector')).toBeVisible();
    await expect(page.locator('.ops-inspector-title')).toHaveText(TEST_HEADLINE);

    await page.getByRole('button', { name: 'Close inspector' }).click();
    await page.evaluate(() => {
      document.dispatchEvent(new CustomEvent('wm:breaking-news', {
        detail: {
          id: 'e2e-alert',
          headline: 'Verified breaking signal',
          source: 'E2E Intelligence Desk',
          timestamp: new Date(),
          threatLevel: 'high',
          description: 'A deterministic alert used to verify the operations-shell handoff.',
          countryCode: 'TH',
          origin: 'rss_alert',
          link: 'https://example.com/vantage-e2e-alert',
        },
      }));
    });

    const alert = page.locator('.breaking-alert[data-alert-id="e2e-alert"]');
    await expect(alert).toBeVisible();
    const layout = await page.evaluate(() => {
      const banner = document.querySelector<HTMLElement>('.breaking-news-container');
      const filter = document.querySelector<HTMLElement>('.ops-filter');
      const body = document.querySelector<HTMLElement>('.ops-body');
      if (!banner || !filter || !body) throw new Error('missing alert-aware shell layout');
      return {
        bannerBottom: banner.getBoundingClientRect().bottom,
        filterTop: filter.getBoundingClientRect().top,
        filterBottom: filter.getBoundingClientRect().bottom,
        bodyTop: body.getBoundingClientRect().top,
      };
    });
    expect(layout.filterTop).toBeGreaterThanOrEqual(layout.bannerBottom - 1);
    expect(layout.bodyTop).toBeGreaterThanOrEqual(layout.filterBottom - 1);

    await alert.click();
    await expect(page.locator('#opsInspector')).toBeVisible();
    await expect(page.locator('.ops-inspector-title')).toHaveText('Verified breaking signal');

    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();
  });

  test('restores a shared inspector deep link after reload', async ({ page }) => {
    await openOpsShell(page);

    await page.locator('.ops-feed-item').filter({ hasText: TEST_HEADLINE }).click();
    const focus = new URL(page.url()).searchParams.get('focus');
    expect(focus).toMatch(/^news:/);

    await page.reload();
    await expect(page.locator('.ops-shell')).toBeVisible();
    await expect(page.locator('#opsInspector')).toBeVisible();
    await expect(page.locator('.ops-inspector-title')).toHaveText(TEST_HEADLINE);
    expect(new URL(page.url()).searchParams.get('focus')).toBe(focus);
  });

  test('recovers the public feed after one cold digest failure', async ({ page }) => {
    await page.unroute('**/api/news/v1/list-feed-digest*');
    let attempts = 0;
    await page.route('**/api/news/v1/list-feed-digest*', async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await route.abort('timedout');
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          categories: {
            politics: {
              items: [{
                source: 'BBC World',
                title: TEST_HEADLINE,
                link: TEST_LINK,
                publishedAt: Date.now(),
                isAlert: false,
              }],
            },
            intel: { items: [] },
          },
          feedStatuses: {},
          generatedAt: new Date().toISOString(),
        }),
      });
    });

    await openOpsShell(page);
    expect(attempts).toBe(2);
  });
});

test.describe('Vantage public mobile shell', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await installDeterministicNews(page);
  });

  test('labels AIR and SHIPS as pending without starting relay-backed requests', async ({ page }) => {
    const relayBackedRequests: string[] = [];
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (/\/(?:get-theater-posture|list-military-flights|list-military-vessels)$/.test(pathname)) {
        relayBackedRequests.push(pathname);
      }
    });

    await page.goto('/');
    await expect(page).toHaveURL(/(?:\?|&)classic=1(?:&|$)/);
    await page.getByText('AI Strategic Posture', { exact: true }).first().scrollIntoViewIfNeeded();
    await expect(page.getByText('AIR/SHIPS relay pending', { exact: true })).toBeVisible();
    await expect(page.getByText('AIR pending', { exact: true })).toBeVisible();
    await expect(page.getByText('SHIPS pending', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Retry Now/i })).toHaveCount(0);
    await page.waitForTimeout(1_000);

    expect(relayBackedRequests).toEqual([]);
    for (const key of ['lat', 'lon']) {
      const value = new URL(page.url()).searchParams.get(key);
      if (value !== null) expect(Number.isFinite(Number(value))).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator('body')).not.toContainText(/sign in|upgrade|pricing/i);
  });
});
