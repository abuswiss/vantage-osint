import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpsShell, type OpsShellHooks } from '@/app/ops-shell';
import type { AppContext } from '@/app/app-context';
import {
  checkpointMonitor, createMonitor, getActiveMonitor, getMonitors,
  toggleTopic, type MonitorPulse, type MonitorWorkspace,
} from '@/services/watchlist';

vi.mock('@/services/insights-loader', () => ({ getServerInsights: () => null }));

// Exercise the actual shell rendering and event handlers without starting
// the unrelated WebGL renderer, timers, or live external data loaders.
interface ShellHarness {
  feedList: HTMLElement;
  feedHasSettled: boolean;
  watchlistRow: HTMLElement;
  watchSettingsOpen: boolean;
  watchBell: HTMLButtonElement;
  monitorEditorMode: 'create' | 'rename' | null;
  coverageCheckFailed: boolean;
  systemStatus: HTMLButtonElement;
  coverageHealth: unknown;
  watchFilter: { kind: 'topic'; value: string } | null;
  buildMonitorControls(monitor: MonitorWorkspace, pulse: MonitorPulse): HTMLElement;
  renderWatchlistStrip(): void;
  renderFeed(): void;
  renderCoverageStatus(): void;
  checkpointActiveMonitor(): void;
  collectFeedItems(applyWindow: boolean): Array<{ sourceCount: number }>;
}

function harness(news = true, hooks: Partial<OpsShellHooks> = {}) {
  const ctx = {
    allNews: news ? [{ title: 'Audit report', source: 'Reuters', link: 'https://example.com/audit', pubDate: new Date() }] : [],
    latestClusters: [], currentTimeRange: '24h', intelligenceCache: {},
  } as unknown as AppContext;
  const shell = new OpsShell(ctx, {
    onToggleLayer() {}, onOpenSearch() {}, onApplyMission() {}, onResetMission() {}, ...hooks,
  });
  const view = shell as unknown as ShellHarness;
  view.feedHasSettled = true;
  view.feedList = document.createElement('div');
  view.watchlistRow = document.createElement('div');
  view.watchBell = document.createElement('button');
  view.watchSettingsOpen = true;
  document.body.append(view.watchlistRow, view.feedList, view.watchBell);
  return { ctx, shell, view };
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll('button')].find((item) => item.textContent === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

afterEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
});

describe('Vantage recovery and monitor controls', () => {
  it('offers a retry for unavailable reporting and recovers when reports arrive', async () => {
    const refresh = vi.fn(async () => {
      ctx.allNews = [{ title: 'Recovered report', source: 'Reuters', link: 'https://example.com/recovered', pubDate: new Date(), isAlert: false }];
    });
    const { ctx, view } = harness(false, { onRefreshFeed: refresh });
    view.renderFeed();
    expect(view.feedList.textContent).toContain('Reports are unavailable');
    button(view.feedList, 'Try again').click();
    await vi.waitFor(() => expect(view.feedList.textContent).toContain('Recovered report'));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('preserves a previous baseline when leaving before reporting is available', () => {
    const { view } = harness(false);
    checkpointMonitor(getActiveMonitor().id, [{ id: 'earlier-report', sourceCount: 2 }], 1234);
    view.checkpointActiveMonitor();
    expect(getActiveMonitor().baseline?.capturedAt).toBe(1234);
    view.renderWatchlistStrip();
    expect(button(view.watchlistRow, 'Mark reviewed').disabled).toBe(true);
  });

  it('clears an empty watch filter without changing the saved watchlist', () => {
    const { view } = harness();
    toggleTopic('shipping');
    view.watchFilter = { kind: 'topic', value: 'shipping' };
    view.renderFeed();
    expect(view.feedList.textContent).toContain('No matching reports');
    button(view.feedList, 'Clear watch filter').click();
    expect(view.feedList.textContent).toContain('Audit report');
    expect(getActiveMonitor().topics).toEqual(['shipping']);
  });

  it('keeps delayed coverage amber and a failed check out of the loading state', () => {
    const { view } = harness();
    view.systemStatus = document.createElement('button');
    view.coverageHealth = {
      status: 'degraded', checkedAt: new Date().toISOString(),
      services: {
        redis: 'ready', news: { status: 'ready' }, insights: { status: 'stale' }, risk: { status: 'ready' },
        relay: { status: 'ready', air: 'ready', ships: 'ready' },
      },
    };
    view.renderCoverageStatus();
    expect(view.systemStatus.dataset.state).toBe('degraded');
    expect(view.systemStatus.textContent).toBe('Coverage 4/5');
    view.coverageHealth = null;
    view.coverageCheckFailed = true;
    view.renderCoverageStatus();
    expect(view.systemStatus.textContent).toBe('Coverage unavailable');
  });

  it('invalidates comparisons when a monitor scope changes', () => {
    checkpointMonitor(getActiveMonitor().id, [{ id: 'old-scope', sourceCount: 2 }]);
    toggleTopic('shipping');
    expect(getActiveMonitor().baseline).toBeNull();
  });

  it('explains a failed monitor creation and preserves the name for retry', () => {
    const { view } = harness();
    view.monitorEditorMode = 'create';
    view.renderWatchlistStrip();
    const input = view.watchlistRow.querySelector<HTMLInputElement>('.ops-monitor-name')!;
    input.value = 'Asia coverage';
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    button(view.watchlistRow, 'Create').click();
    expect(view.watchlistRow.textContent).toContain('Could not create a monitor');
    expect(input.value).toBe('Asia coverage');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(getMonitors()).toHaveLength(1);
  });

  it('restores the actual selection when switching monitors cannot be saved', () => {
    createMonitor('Asia coverage');
    const id = getActiveMonitor().id;
    const { view } = harness();
    view.renderWatchlistStrip();
    const select = view.watchlistRow.querySelector<HTMLSelectElement>('select')!;
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    select.value = 'default';
    select.dispatchEvent(new Event('change'));
    expect(select.value).toBe(id);
    expect(view.watchlistRow.textContent).toContain('Could not switch monitors');
  });

  it('lets Escape cancel a monitor edit without saving', () => {
    const { view } = harness();
    view.monitorEditorMode = 'rename';
    view.renderWatchlistStrip();
    const input = view.watchlistRow.querySelector<HTMLInputElement>('.ops-monitor-name')!;
    input.value = 'Uncommitted name';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(view.watchlistRow.querySelector('.ops-monitor-name')).toBeNull();
    expect(getActiveMonitor().name).toBe('My monitor');
  });

  it('does not count repeated reporting from one outlet as corroboration', () => {
    const { ctx, view } = harness();
    ctx.latestClusters = [{
      id: 'cluster', primaryTitle: 'Report', primarySource: 'Reuters', primaryLink: 'https://example.com/1',
      lastUpdated: new Date(), sourceCount: 1, topSources: [],
      allItems: [{ source: 'Reuters' }, { source: 'Reuters' }, { source: ' reuters ' }],
    }] as unknown as AppContext['latestClusters'];
    expect(view.collectFeedItems(false)[0]?.sourceCount).toBe(1);
  });

  it('updates review counts when new data arrives without losing a draft name', () => {
    const { ctx, view } = harness(false);
    view.monitorEditorMode = 'create';
    view.renderWatchlistStrip();
    const input = view.watchlistRow.querySelector<HTMLInputElement>('.ops-monitor-name')!;
    input.value = 'Draft monitor';
    ctx.allNews = [{ title: 'New report', source: 'Reuters', link: 'https://example.com/new', pubDate: new Date(), isAlert: false }];
    view.renderFeed();
    expect(button(view.watchlistRow, 'Mark reviewed').disabled).toBe(false);
    expect(input.value).toBe('Draft monitor');
  });
});
