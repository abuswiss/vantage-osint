import { devices, expect, test, type Page } from '@playwright/test';

type PaintEntrySnapshot = {
  name: string;
  startTime: number;
};

type LcpEntrySnapshot = {
  className: string;
  inShell: boolean;
  size: number;
  startTime: number;
  text: string;
};

const { defaultBrowserType: mobileDefaultBrowserType, ...mobileDevice } = devices['iPhone 14 Pro Max'];
void mobileDefaultBrowserType;

const SHELL_LCP_TEXT = 'Intelligence workspace is loading';

declare global {
  interface Window {
    __wmPaintEntries?: PaintEntrySnapshot[];
    __wmLcpEntries?: LcpEntrySnapshot[];
    __wmWelcomeHydrationDispatched?: boolean;
    __wmWelcomeRootClearCount?: number;
  }
}

const installPaintObservers = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    window.__wmPaintEntries = [];
    window.__wmLcpEntries = [];

    try {
      const paintObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__wmPaintEntries?.push({
            name: entry.name,
            startTime: entry.startTime,
          });
        }
      });
      paintObserver.observe({ type: 'paint', buffered: true });
    } catch {
      // Older engines without paint timing still exercise the DOM candidate below.
    }

    try {
      const lcpObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as PerformanceEntry[]) {
          const lcp = entry as PerformanceEntry & {
            element?: Element;
            size?: number;
          };
          window.__wmLcpEntries?.push({
            className: typeof lcp.element?.className === 'string' ? lcp.element.className : '',
            inShell: Boolean(lcp.element?.closest('.skeleton-shell')),
            size: lcp.size ?? 0,
            startTime: lcp.startTime,
            text: lcp.element?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 140) ?? '',
          });
        }
      });
      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
      // WebKit/older engines may not expose LCP, so FCP + visible candidate is the hard gate.
    }
  });
};

const delayDashboardMain = async (page: Page): Promise<{ release: () => void; requested: Promise<void> }> => {
  let releaseMain!: () => void;
  let resolveRequested!: () => void;
  const releasePromise = new Promise<void>((resolve) => {
    releaseMain = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    resolveRequested = resolve;
  });

  await page.route('**/src/main.ts', async (route) => {
    resolveRequested();
    await releasePromise;
    await route.continue();
  });

  return { release: releaseMain, requested };
};

const delayWelcomeMain = async (page: Page): Promise<{ release: () => void; requested: Promise<void> }> => {
  let releaseMain!: () => void;
  let resolveRequested!: () => void;
  const releasePromise = new Promise<void>((resolve) => {
    releaseMain = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    resolveRequested = resolve;
  });

  await page.route('**/pro/assets/welcome-*.js', async (route) => {
    resolveRequested();
    await releasePromise;
    await route.continue();
  });

  return { release: releaseMain, requested };
};

const delayOpsShellModule = async (page: Page): Promise<{ release: () => void; requested: Promise<void> }> => {
  let releaseModule!: () => void;
  let resolveRequested!: () => void;
  const releasePromise = new Promise<void>((resolve) => {
    releaseModule = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    resolveRequested = resolve;
  });

  await page.route('**/src/app/ops-shell.ts', async (route) => {
    resolveRequested();
    await releasePromise;
    await route.continue();
  });

  return { release: releaseModule, requested };
};

test.describe('pre-hydration dashboard shell', () => {
  test.beforeEach(async ({ page }) => {
    await installPaintObservers(page);
  });

  test('paints contentful HTML before the dashboard bundle hydrates', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const delayedMain = await delayDashboardMain(page);
    let released = false;
    const releaseMain = () => {
      if (released) return;
      released = true;
      delayedMain.release();
    };

    try {
      await page.goto('/', { waitUntil: 'commit' });
      await delayedMain.requested;
      await expect(page.locator('.skeleton-shell')).toBeVisible();
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));

      await expect.poll(async () => page.evaluate(() => (
        performance.getEntriesByName('first-contentful-paint').length
          + (window.__wmPaintEntries ?? []).filter((entry) => entry.name === 'first-contentful-paint').length
      )), {
        message: 'first-contentful-paint should fire while the dashboard module is still blocked',
        timeout: 5000,
      }).toBeGreaterThan(0);

      await expect.poll(async () => page.evaluate(() => {
        if (document.documentElement.classList.contains('wm-layout-hydrated')) return -1;
        return (window.__wmLcpEntries ?? []).filter((entry) => (
          entry.inShell
          && entry.size > 0
          && entry.className.includes('skeleton-')
          && entry.text.length > 0
        )).length;
      }), {
        message: 'largest-contentful-paint should be the server-delivered shell before hydration',
        timeout: 5000,
      }).toBeGreaterThan(0);

      const preHydration = await page.evaluate(() => {
        const shell = document.querySelector<HTMLElement>('.skeleton-shell');
        const candidate = document.querySelector<HTMLElement>('.skeleton-lcp-copy');
        const appHeading = document.querySelector<HTMLElement>('body > h1.app-heading');
        const badgeGroup = document.querySelector<HTMLElement>('.skeleton-map-badges');
        if (!shell || !candidate) {
          throw new Error('missing pre-hydration shell content');
        }

        const rect = candidate.getBoundingClientRect();
        const styles = getComputedStyle(candidate);
        const fcp = performance.getEntriesByName('first-contentful-paint')[0];
        const focusable = shell.querySelectorAll(
          'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])',
        );

        return {
          ariaBusy: shell.getAttribute('aria-busy'),
          ariaHidden: shell.getAttribute('aria-hidden'),
          appHeadingAriaHidden: appHeading?.getAttribute('aria-hidden') ?? null,
          appHeadingText: appHeading?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          appHeadingTag: appHeading?.tagName ?? '',
          badgeAriaLabel: badgeGroup?.getAttribute('aria-label') ?? null,
          candidateRect: {
            height: rect.height,
            width: rect.width,
            x: rect.x,
            y: rect.y,
          },
          candidateText: candidate.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          display: styles.display,
          fcpStart: fcp?.startTime ?? null,
          focusableCount: focusable.length,
          hydrated: document.documentElement.classList.contains('wm-layout-hydrated'),
          lcpEntries: window.__wmLcpEntries ?? [],
          opacity: Number(styles.opacity),
          shellText: shell.innerText.replace(/\s+/g, ' ').trim(),
          visibility: styles.visibility,
        };
      });

      expect(preHydration.hydrated).toBe(false);
      expect(preHydration.ariaHidden).toBeNull();
      expect(preHydration.ariaBusy).toBe('true');
      expect(preHydration.appHeadingTag).toBe('H1');
      expect(preHydration.appHeadingAriaHidden).toBeNull();
      expect(preHydration.appHeadingText).toContain('Vantage');
      expect(preHydration.badgeAriaLabel).toBeNull();
      expect(preHydration.focusableCount).toBe(0);
      expect(preHydration.shellText).toContain('Vantage');
      expect(preHydration.shellText).toContain(SHELL_LCP_TEXT);
      expect(preHydration.shellText).toContain('Intelligence');
      expect(preHydration.candidateText).toBe(SHELL_LCP_TEXT);
      expect(preHydration.candidateRect.width).toBeGreaterThan(260);
      expect(preHydration.candidateRect.height).toBeGreaterThan(18);
      expect(preHydration.display).not.toBe('none');
      expect(preHydration.visibility).toBe('visible');
      expect(preHydration.opacity).toBeGreaterThan(0.9);
      expect(preHydration.fcpStart).not.toBeNull();

      const latestLcp = preHydration.lcpEntries.at(-1);
      expect(latestLcp, JSON.stringify(preHydration.lcpEntries)).toBeTruthy();
      expect(latestLcp!.inShell, JSON.stringify(preHydration.lcpEntries)).toBe(true);
      expect(latestLcp!.className).toContain('skeleton-');
      expect(latestLcp!.size).toBeGreaterThan(0);
      expect(latestLcp!.text.length).toBeGreaterThan(0);

      releaseMain();

      await expect(page.locator('.ops-shell')).toBeVisible({ timeout: 30000 });
      await expect(page.locator('.skeleton-shell')).toHaveCount(0);
      await expect(page.locator('body > h1.app-heading')).toContainText('Vantage');
      for (const href of [
        '/countries/',
        '/chokepoints/',
        '/crises/',
        '/tools/',
        '/blog/',
        '/docs',
        'https://github.com/abuswiss/vantage-osint',
        'https://github.com/koala73/worldmonitor',
      ]) {
        await expect(page.locator(`.site-footer nav a[href="${href}"]`)).toHaveCount(1);
      }
      for (const href of ['/countries/', '/chokepoints/', '/crises/', '/tools/']) {
        await expect(page.locator(`.mobile-menu-footer-links a[href="${href}"]`)).toHaveCount(1);
      }
      await expect.poll(async () => page.evaluate(() => (
        document.documentElement.classList.contains('wm-layout-hydrated')
      ))).toBe(true);
      expect(pageErrors.filter((message) => /hydration|skeleton|layout/i.test(message))).toHaveLength(0);
    } finally {
      releaseMain();
    }
  });

  test('keeps the workspace shell covering the legacy plumbing render', async ({ page }) => {
    const delayedOpsShell = await delayOpsShellModule(page);
    try {
      await page.goto('/', { waitUntil: 'commit' });
      await delayedOpsShell.requested;

      await expect(page.locator('.header')).toHaveCount(1);
      await expect(page.locator('.skeleton-shell-handoff')).toBeVisible();
      const paintedSurface = await page.evaluate(() => {
        const shell = document.querySelector<HTMLElement>('.skeleton-shell-handoff');
        const app = document.getElementById('app');
        const transientControl = app?.querySelector<HTMLElement>('button, a[href]') ?? null;
        transientControl?.focus();
        const rect = shell?.getBoundingClientRect();
        const styles = shell ? getComputedStyle(shell) : null;
        return {
          appAriaHidden: app?.getAttribute('aria-hidden'),
          appInert: app?.inert,
          coversViewport: Boolean(rect
            && rect.left <= 0 && rect.top <= 0
            && rect.right >= window.innerWidth && rect.bottom >= window.innerHeight),
          focusEnteredPlumbing: document.activeElement === transientControl,
          opacity: styles?.opacity,
          pointerEvents: styles?.pointerEvents,
          shellAriaHidden: shell?.getAttribute('aria-hidden'),
          zIndex: styles?.zIndex,
        };
      });
      expect(paintedSurface).toEqual({
        appAriaHidden: 'true',
        appInert: true,
        coversViewport: true,
        focusEnteredPlumbing: false,
        opacity: '1',
        pointerEvents: 'auto',
        shellAriaHidden: 'true',
        zIndex: '10000',
      });

      delayedOpsShell.release();
      await expect(page.locator('.ops-shell')).toBeVisible({ timeout: 30000 });
      await expect(page.locator('.skeleton-shell')).toHaveCount(0);
      await expect(page.locator('#app')).not.toHaveAttribute('aria-hidden');
      expect(await page.locator('#app').evaluate((element) => (element as HTMLElement).inert)).toBe(false);
    } finally {
      delayedOpsShell.release();
    }
  });

  test('replaces a failed workspace chunk with a usable recovery surface', async ({ page }) => {
    await page.route('**/src/app/ops-shell.ts', async (route) => {
      await route.abort('failed');
    });

    await page.goto('/', { waitUntil: 'commit' });

    const recovery = page.getByRole('alert', { name: 'Vantage could not finish starting' });
    await expect(recovery).toBeVisible({ timeout: 30000 });
    await expect(recovery).toContainText('Your data is unchanged');
    await expect(page.locator('.skeleton-shell-handoff')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry workspace' })).toBeFocused();
    const classic = page.getByRole('link', { name: 'Use classic dashboard' });
    await expect(classic).toHaveAttribute('href', /[?&]classic=1(?:&|$)/);
    await expect(page.locator('#app')).toHaveAttribute('aria-hidden', 'true');
    expect(await page.locator('#app').evaluate((element) => (element as HTMLElement).inert)).toBe(true);
    const geometry = await recovery.locator('.ops-boot-failure-card').evaluate((card) => {
      const rect = card.getBoundingClientRect();
      return {
        centeredX: Math.abs((rect.left + rect.width / 2) - window.innerWidth / 2),
        centeredY: Math.abs((rect.top + rect.height / 2) - window.innerHeight / 2),
        insideViewport: rect.left >= 0 && rect.top >= 0
          && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
      };
    });
    expect(geometry.insideViewport).toBe(true);
    expect(geometry.centeredX).toBeLessThanOrEqual(1);
    expect(geometry.centeredY).toBeLessThanOrEqual(1);
  });
});

test.describe('pre-hydration workspace shell on tablet', () => {
  test.use({ viewport: { width: 820, height: 1180 } });

  test('keeps the stacked map footprint stable at the 820px handoff', async ({ page }) => {
    const delayedOpsShell = await delayOpsShellModule(page);
    try {
      await page.goto('/', { waitUntil: 'commit' });
      await delayedOpsShell.requested;
      await expect(page.locator('.skeleton-ops-map')).toBeVisible();

      const boot = await page.locator('.skeleton-ops-map').boundingBox();
      expect(boot).not.toBeNull();
      expect(boot!.width).toBe(820);
      expect(boot!.height).toBeGreaterThan(200);

      delayedOpsShell.release();
      await expect(page.locator('.ops-map')).toBeVisible({ timeout: 30000 });
      await expect(page.locator('.skeleton-shell')).toHaveCount(0);
      const live = await page.locator('.ops-map').boundingBox();
      expect(live).not.toBeNull();
      expect(Math.abs(live!.width - boot!.width), 'tablet map width drift').toBeLessThanOrEqual(1);
      expect(Math.abs(live!.height - boot!.height), 'tablet map height drift').toBeLessThanOrEqual(2);
    } finally {
      delayedOpsShell.release();
    }
  });
});

test.describe('pre-hydration dashboard shell on mobile', () => {
  test.use({
    ...mobileDevice,
    viewport: { width: 360, height: 780 },
    deviceScaleFactor: 2.625,
  });

  test.beforeEach(async ({ page }) => {
    await installPaintObservers(page);
  });

  test('keeps the contentful shell inside the mobile viewport before hydration', async ({ page }) => {
    const delayedMain = await delayDashboardMain(page);
    let released = false;
    const releaseMain = () => {
      if (released) return;
      released = true;
      delayedMain.release();
    };

    try {
      await page.goto('/', { waitUntil: 'commit' });
      await delayedMain.requested;
      await expect(page.locator('.skeleton-shell')).toBeVisible();
      await expect(page.locator('.skeleton-lcp-copy')).toBeVisible();
      await expect(page.locator('[data-shell-lcp]')).toHaveText(SHELL_LCP_TEXT);

      await expect.poll(async () => page.evaluate(() => (
        performance.getEntriesByName('first-contentful-paint').length
          + (window.__wmPaintEntries ?? []).filter((entry) => entry.name === 'first-contentful-paint').length
      )), {
        message: 'mobile first-contentful-paint should fire while the dashboard module is still blocked',
        timeout: 5000,
      }).toBeGreaterThan(0);

      const mobileShell = await page.evaluate(() => {
        const title = document.querySelector('.skeleton-lcp-copy');
        const panel = document.querySelector('.skeleton-ops-feed');
        const titleRect = title?.getBoundingClientRect();
        const panelRect = panel?.getBoundingClientRect();
        return {
          hydrated: document.documentElement.classList.contains('wm-layout-hydrated'),
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          titleRect: titleRect ? {
            bottom: titleRect.bottom,
            height: titleRect.height,
            left: titleRect.left,
            right: titleRect.right,
            top: titleRect.top,
            width: titleRect.width,
          } : null,
          panelRect: panelRect ? {
            bottom: panelRect.bottom,
            height: panelRect.height,
            left: panelRect.left,
            right: panelRect.right,
            top: panelRect.top,
            width: panelRect.width,
          } : null,
        };
      });

      expect(mobileShell.hydrated).toBe(false);
      expect(mobileShell.scrollWidth).toBeLessThanOrEqual(mobileShell.innerWidth + 1);
      expect(mobileShell.titleRect).not.toBeNull();
      expect(mobileShell.titleRect!.left).toBeGreaterThanOrEqual(0);
      expect(mobileShell.titleRect!.right).toBeLessThanOrEqual(mobileShell.innerWidth);
      expect(mobileShell.titleRect!.height).toBeGreaterThan(20);
      expect(mobileShell.panelRect).not.toBeNull();
      expect(mobileShell.panelRect!.left).toBeGreaterThanOrEqual(0);
      expect(mobileShell.panelRect!.right).toBeLessThanOrEqual(mobileShell.innerWidth);

      releaseMain();

      await expect(page.locator('.ops-shell')).toBeVisible({ timeout: 30000 });
      await expect(page.locator('.skeleton-shell')).toHaveCount(0);
    } finally {
      releaseMain();
    }
  });

  test('matches the mobile map footprint through the OpsShell handoff', async ({ page }) => {
    const delayedMain = await delayDashboardMain(page);
    let released = false;
    const releaseMain = () => {
      if (released) return;
      released = true;
      delayedMain.release();
    };

    try {
      await page.goto('/', { waitUntil: 'commit' });
      await delayedMain.requested;
      await expect(page.locator('.skeleton-ops-map')).toBeVisible();

      const shellHeight = await page.locator('.skeleton-ops-map').evaluate((element) => element.getBoundingClientRect().height);
      expect(shellHeight).toBeGreaterThan(0);

      releaseMain();

      await expect(page.locator('.ops-map')).toBeVisible({ timeout: 30000 });
      await expect(page.locator('.skeleton-shell')).toHaveCount(0);
      const hydratedHeight = await page.locator('.ops-map').evaluate((element) => element.getBoundingClientRect().height);

      expect(Math.abs(hydratedHeight - shellHeight), 'mobile map footprint drift').toBeLessThanOrEqual(2);
    } finally {
      releaseMain();
    }
  });
});

test.describe('server-rendered welcome page', () => {
  test('keeps one visible heading and discoverable navigation after hydration', async ({ page }) => {
    await page.goto('/pro/welcome.html', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#seo-prerender')).toHaveCount(0);
    await expect(page.locator('#root[data-wm-prerendered="welcome"] h1')).toHaveCount(1);
    await expect(page.locator('#root h1')).toBeVisible();
    await expect(page.locator('#root a[href="/dashboard?ref=welcome-hero"]')).toBeVisible();
    await expect(page.locator('#root footer a[href="/countries/"]')).toBeVisible();
    await expect(page.locator('#root footer a[href="https://github.com/koala73/worldmonitor"]')).toBeVisible();
  });

  test('keeps the English prerender visible while its module is blocked', async ({ page }) => {
    const delayedMain = await delayWelcomeMain(page);

    try {
      await page.goto('/pro/welcome.html?lang=en', { waitUntil: 'commit' });
      await delayedMain.requested;

      await expect(page.locator('#root[data-wm-prerender-lang="en"]')).toBeVisible();
    } finally {
      delayedMain.release();
    }
  });

  for (const language of ['fr', 'ar']) {
    test(`keeps the English prerender for ${language} when welcome copy falls back`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.addInitScript(() => {
        const originalReplaceChildren = Element.prototype.replaceChildren;
        Element.prototype.replaceChildren = function replaceChildren(...nodes) {
          if (this.id === 'root') {
            window.__wmWelcomeRootClearCount = (window.__wmWelcomeRootClearCount ?? 0) + 1;
          }
          return originalReplaceChildren.call(this, ...nodes);
        };
        window.requestIdleCallback = (callback) => window.setTimeout(() => {
          callback({
            didTimeout: false,
            timeRemaining: () => 50,
          });
          window.__wmWelcomeHydrationDispatched = true;
        }, 0);
      });
      const delayedMain = await delayWelcomeMain(page);

      try {
        await page.goto(`/pro/welcome.html?lang=${language}`, { waitUntil: 'commit' });
        await delayedMain.requested;

        const root = page.locator('#root[data-wm-prerender-lang="en"]');
        await expect(root).toContainText("By the time it's news");
        await expect(root).toBeVisible();
        await expect.poll(async () => page.evaluate(() => ({
          direction: getComputedStyle(document.documentElement).direction,
          language: document.documentElement.lang,
        }))).toEqual({
          direction: 'ltr',
          language: 'en',
        });
        expect(await page.evaluate(() => window.__wmWelcomeRootClearCount ?? 0)).toBe(0);

        delayedMain.release();

        await expect.poll(async () => page.evaluate(() => (
          window.__wmWelcomeHydrationDispatched ?? false
        ))).toBe(true);
        await page.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        await expect(root).toBeVisible();
        await expect.poll(async () => page.evaluate(() => ({
          direction: getComputedStyle(document.documentElement).direction,
          language: document.documentElement.lang,
          ogLocale: document.querySelector('meta[property="og:locale"]')?.getAttribute('content'),
        }))).toEqual({
          direction: 'ltr',
          language: 'en',
          ogLocale: 'en_US',
        });
        expect(await page.evaluate(() => window.__wmWelcomeRootClearCount ?? 0)).toBe(0);
        expect(pageErrors).toEqual([]);
      } finally {
        delayedMain.release();
      }
    });
  }
});

test.describe('dashboard shell without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('keeps the server-rendered welcome page visibly useful', async ({ page }) => {
    await page.goto('/pro/welcome.html', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#seo-prerender')).toHaveCount(0);
    await expect(page.locator('#root[data-wm-prerendered="welcome"]')).toBeVisible();
    await expect(page.locator('#root h1')).toHaveCount(1);
    await expect(page.locator('#root h1')).toBeVisible();
    await expect(page.locator('#root h1')).toContainText('you already knew');
    await expect(page.locator('#root a[href="/dashboard?ref=welcome-hero"]')).toBeVisible();
    await expect(page.locator('#root footer a[href="/countries/"]')).toBeVisible();
    await expect(page.locator('#root footer a[href="https://github.com/koala73/worldmonitor"]')).toBeVisible();
  });

  test('hides the JS-only shell and keeps the no-JS content scrollable', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('.skeleton-shell')).toBeHidden();
    await expect(page.locator('body > h1.app-heading')).toContainText('Vantage');
    await expect(page.locator('body > h1.app-heading')).not.toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#seo-prerender')).toHaveCount(0);
    await expect(page.locator('#dashboard-noscript')).toBeVisible();
    await expect(page.locator('#dashboard-noscript')).toContainText('requires JavaScript');
    for (const href of [
      '/countries/',
      '/chokepoints/',
      '/crises/',
      '/tools/',
      '/blog/',
      '/docs',
      'https://github.com/abuswiss/vantage-osint',
      'https://github.com/koala73/worldmonitor',
    ]) {
      await expect(page.locator(`#dashboard-noscript a[href="${href}"]`)).toHaveCount(1);
    }

    const beforeScroll = await page.evaluate(() => ({
      bodyOverflow: getComputedStyle(document.body).overflow,
      docOverflow: getComputedStyle(document.documentElement).overflow,
    }));

    expect(beforeScroll.bodyOverflow).not.toBe('hidden');
    expect(beforeScroll.docOverflow).not.toBe('hidden');
  });
});
