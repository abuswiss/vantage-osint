/**
 * OpsShell — map-first common operating picture.
 *
 * The classic panel grid remains mounted in an off-screen dock so its existing
 * data loaders keep running. The shell adopts the live map/header controls and
 * turns the same stores into an operator feed, activity timeline, and inspector.
 * `?classic=1` remains the explicit opt-out.
 */
import type { AppContext } from '@/app/app-context';
import type {
  ClusteredEvent,
  CountryBriefSignals,
  Hotspot,
  MapLayers,
  NewsItem,
  ThreatClassification,
} from '@/types';
import type { CountryDeepDiveSignalDetails } from '@/components/CountryBriefPanel';
import type { TimeRange } from '@/components/MapContainer';
import type { BreakingAlert } from '@/services/breaking-news-alerts';
import type { LayerDefinition, MapRenderer, MapVariant } from '@/config/map-layer-definitions';
import { BRAND } from '@/config/brand';
import { SITE_VARIANT } from '@/config';
import {
  getLayersForVariant,
  isLayerCommandAllowed,
  isLayerExecutable,
} from '@/config/map-layer-definitions';
import {
  VANTAGE_PUBLIC_MODE,
  VANTAGE_RELAY_ENABLED,
  isPublicVantageCapability,
} from '@/config/product-policy';
import { getCachedScores } from '@/services/cached-risk-scores';
import { getAisStatus } from '@/services/maritime';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { hasPremiumAccess } from '@/services/panel-gating';
import { fetchServerInsights, getServerInsights } from '@/services/insights-loader';
import { buildVantageSynthesis, type VantageSynthesis } from '@/services/vantage-synthesis';
import {
  fetchBriefDiff,
  fetchBriefHistory,
  fetchBriefSnapshot,
  type ArchivedBriefSnapshot,
} from '@/services/brief-history';
import {
  getAlertPrefs,
  getWatchlist,
  isWatched,
  setAlertPrefs,
  subscribe as subscribeWatchlist,
  toggleCountry,
  toggleTopic,
  type AlertPrefs,
  type Watchlist,
} from '@/services/watchlist';
import { toFlagEmoji } from '@/utils/country-flag';
import { getStrategicRiskDisplayLevel } from '@/utils/strategic-risk-band';

export interface OpsShellHooks {
  onToggleLayer: (layer: keyof MapLayers, enabled: boolean) => void;
  onOpenSearch: () => void;
}

/**
 * Country-intel delegate handed to inspectCountry by CountryIntelManager, so
 * the shell can render country signals without importing the (heavy)
 * country-intel module graph.
 */
export interface OpsCountryIntel {
  getSignals(): Promise<CountryBriefSignals>;
  getSignalDetails(): Promise<CountryDeepDiveSignalDetails>;
  openFullBrief(): void;
}

export interface OpsSearchSummary {
  id: string;
  title: string;
  subtitle?: string;
  type: 'market' | 'prediction';
}

interface LayerChipDef {
  key: keyof MapLayers;
  label: string;
  cssVar: string;
}

interface OpsFeedItem {
  id: string;
  legacyFocusId?: string;
  title: string;
  source: string;
  link: string;
  when: Date;
  alert: boolean;
  sourceCount: number;
  topSources: Array<{ name: string; url: string }>;
  allItems: NewsItem[];
  lat?: number;
  lon?: number;
  locationName?: string;
  snippet?: string;
  threat?: ThreatClassification;
}

type InspectorSelection =
  | { kind: 'feed'; item: OpsFeedItem }
  | { kind: 'hotspot'; hotspot: Hotspot }
  | { kind: 'alert'; alert: BreakingAlert }
  | { kind: 'search'; result: OpsSearchSummary }
  | { kind: 'brief'; brief: VantageSynthesis | null }
  | { kind: 'country'; code: string; name: string }
  | { kind: 'signal' };

type WatchFilter = { kind: 'country' | 'topic'; value: string };
type FeedOrder = 'priority' | 'latest';

const PRIMARY_LAYER_CHIPS: LayerChipDef[] = [
  { key: 'hotspots', label: 'Events', cssVar: '--ops-dom-events' },
  { key: 'conflicts', label: 'Strikes', cssVar: '--ops-dom-strikes' },
  { key: 'bases', label: 'Bases', cssVar: '--ops-dom-bases' },
  { key: 'military', label: 'Air', cssVar: '--ops-dom-air' },
  { key: 'ais', label: 'Ships', cssVar: '--ops-dom-ships' },
];

const TIME_RANGES: TimeRange[] = ['1h', '6h', '24h', '48h', '7d', 'all'];
const TIME_RANGE_MS: Partial<Record<TimeRange, number>> = {
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '48h': 48 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

const FEED_LIMIT = 80;
const TIMELINE_BUCKETS = 16;
const HUD_REFRESH_MS = 30_000;
const FOCUS_PARAM = 'focus';
const FLASH_MS = 1_300;
const CITATION_PATTERN = /\[(\d{1,2})\]/g;
const ESCALATION_HISTORY_KEY = 'wm-escalation-history';
const ESCALATION_HISTORY_LIMIT = 288;
const ESCALATION_BUCKET_MS = 5 * 60_000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const ALERT_COOLDOWN_MS = 5 * 60_000;
const SEEN_ALERT_LIMIT = 500;
const BRIEF_HISTORY_LIMIT = 8;

interface EscalationSample {
  t: number;
  score: number;
}

export class OpsShell {
  private readonly ctx: AppContext;
  private readonly hooks: OpsShellHooks;
  private root: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private panelDock: HTMLElement | null = null;
  private feedList: HTMLElement | null = null;
  private feedCount: HTMLElement | null = null;
  private inspector: HTMLElement | null = null;
  private timelineBars: HTMLElement | null = null;
  private timelineMeta: HTMLElement | null = null;
  private layerPopover: HTMLElement | null = null;
  private moreLayersButton: HTMLButtonElement | null = null;
  private briefButton: HTMLButtonElement | null = null;
  private systemStatus: HTMLElement | null = null;
  private briefPreviewHost: HTMLElement | null = null;
  private briefPreviewButton: HTMLButtonElement | null = null;
  private shortcutsOverlay: HTMLElement | null = null;
  private chipButtons = new Map<keyof MapLayers, Set<HTMLButtonElement>>();
  private timeButtons = new Map<TimeRange, Set<HTMLButtonElement>>();
  private feedOrderButtons = new Map<FeedOrder, HTMLButtonElement>();
  private feedOrder: FeedOrder = 'priority';
  private selection: InspectorSelection | null = null;
  private hudScore: HTMLElement | null = null;
  private hudLevel: HTMLElement | null = null;
  private countAir: HTMLElement | null = null;
  private countShips: HTMLElement | null = null;
  private countEvents: HTMLElement | null = null;
  private statusLine: HTMLElement | null = null;
  private hudTimer: ReturnType<typeof setInterval> | null = null;
  private bootHandoffTimer: number | null = null;
  private feedHasSettled = false;
  private briefLoading = false;
  private focusRestoreTimers: number[] = [];
  private escalationHistory: EscalationSample[] | null = null;
  private watchlistRow: HTMLElement | null = null;
  private watchBell: HTMLButtonElement | null = null;
  private watchFilter: WatchFilter | null = null;
  private watchSettingsOpen = false;
  private unsubscribeWatchlist: (() => void) | null = null;
  private lastAlertScore: number | null = null;
  private alertsSeeded = false;
  private seenAlertIds = new Set<string>();
  private lastNotifiedAt: Record<'escalation' | 'watchlist', number> = { escalation: 0, watchlist: 0 };
  private lastBriefRevalidatedAt = 0;
  private unsubscribeAuth: (() => void) | null = null;
  private boundKeydown: ((event: KeyboardEvent) => void) | null = null;
  private boundOutsidePointer: ((event: PointerEvent) => void) | null = null;
  private boundOpsAlert: ((event: Event) => void) | null = null;
  private legacyMain: HTMLElement | null = null;
  private legacyMainRole: string | null = null;
  private legacyMainAriaHidden: string | null = null;
  private legacyMainWasInert = false;
  private legacyMainWasHidden = false;
  private skipLink: HTMLAnchorElement | null = null;
  private skipLinkHref = '';
  private skipLinkText = '';
  private boundSkipClick: ((event: MouseEvent) => void) | null = null;
  private inspectorReturnFocus: HTMLElement | null = null;
  private layerReturnFocus: HTMLElement | null = null;
  private shortcutsReturnFocus: HTMLElement | null = null;
  private destroyed = false;

  constructor(ctx: AppContext, hooks: OpsShellHooks) {
    this.ctx = ctx;
    this.hooks = hooks;
  }

  mount(): void {
    if (this.root) return;
    document.body.classList.add('ops-mode');

    const shell = el('div', 'ops-shell');
    const hasBootHandoff = Boolean(document.querySelector('.skeleton-shell-handoff'));
    if (hasBootHandoff) {
      shell.inert = true;
      shell.setAttribute('aria-hidden', 'true');
    }
    shell.append(
      this.buildTopBar(),
      this.buildBody(),
      this.buildBottomBar(),
      this.buildShortcutsOverlay(),
    );
    document.body.appendChild(shell);
    this.root = shell;

    this.prepareLandmarks();
    this.dockLegacyPanels();
    this.adoptMap();
    this.adoptHeaderControls();
    this.installInteractionHandlers();

    this.ctx.map?.onHotspotClicked((hotspot) => this.inspectHotspot(hotspot));
    if (!VANTAGE_PUBLIC_MODE) {
      this.unsubscribeAuth = subscribeAuthState(() => this.syncLayerChips());
    }

    this.unsubscribeWatchlist = subscribeWatchlist(() => {
      this.renderWatchlistStrip();
      this.renderFeed();
    });

    this.syncLayerChips();
    this.syncTimeChips(this.ctx.currentTimeRange);
    this.renderWatchlistStrip();
    this.feedHasSettled = this.ctx.initialLoadComplete || this.collectFeedItems(false).length > 0;
    this.renderFeed();
    this.updateHud();
    this.restoreDeepLinkedFocus();
    this.hudTimer = setInterval(() => this.updateHud(), HUD_REFRESH_MS);
    requestAnimationFrame(() => this.ctx.map?.resize?.());
    this.completeBootHandoff();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.hudTimer) clearInterval(this.hudTimer);
    if (this.bootHandoffTimer !== null) window.clearTimeout(this.bootHandoffTimer);
    for (const timer of this.focusRestoreTimers) window.clearTimeout(timer);
    this.focusRestoreTimers = [];
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = null;
    this.unsubscribeWatchlist?.();
    this.unsubscribeWatchlist = null;
    if (this.boundKeydown) document.removeEventListener('keydown', this.boundKeydown);
    if (this.boundOutsidePointer) document.removeEventListener('pointerdown', this.boundOutsidePointer);
    if (this.boundOpsAlert) document.removeEventListener('wm:ops-inspect-alert', this.boundOpsAlert);
    this.panelDock?.remove();
    this.panelDock = null;
    this.restoreLandmarks();
    this.root?.remove();
    this.root = null;
    this.ctx.container.inert = false;
    this.ctx.container.removeAttribute('aria-hidden');
    delete this.ctx.container.dataset.opsHandoff;
    document.body.classList.remove('ops-mode');
  }

  /** Fade the contentful boot shell only after the live map/feed frame exists. */
  private completeBootHandoff(): void {
    const bootShell = document.querySelector<HTMLElement>('.skeleton-shell-handoff');
    if (!bootShell) {
      if (this.root) {
        this.root.inert = false;
        this.root.removeAttribute('aria-hidden');
      }
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (this.root) {
        this.root.inert = false;
        this.root.removeAttribute('aria-hidden');
      }
      this.ctx.container.inert = false;
      this.ctx.container.removeAttribute('aria-hidden');
      delete this.ctx.container.dataset.opsHandoff;
      // An extension or host may remove the visual boot node between frames;
      // the live shell must still leave its temporary inert state.
      if (!bootShell.isConnected) return;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        bootShell.remove();
        return;
      }
      bootShell.classList.add('is-leaving');
      this.bootHandoffTimer = window.setTimeout(() => {
        bootShell.remove();
        this.bootHandoffTimer = null;
      }, 200);
    }));
  }

  /** Called whenever the news/cluster stores change. */
  onDataUpdated(): void {
    if (this.destroyed) return;
    this.feedHasSettled = true;
    this.renderFeed();
    this.updateHud();
    this.restoreDeepLinkedFocus();
  }

  /** Called when the news loader completes, including an honest empty/error pass. */
  onFeedLoadSettled(): void {
    if (this.destroyed || this.feedHasSettled) return;
    this.feedHasSettled = true;
    this.renderFeed();
  }

  /** Called from the app's single map time-range callback. */
  onTimeRangeChanged(range: TimeRange): void {
    if (this.destroyed) return;
    this.ctx.currentTimeRange = range;
    this.syncTimeChips(range);
    this.renderFeed();
  }

  /** Keep every duplicate layer control in sync with map state. */
  syncLayerChips(): void {
    for (const [key, buttons] of this.chipButtons) {
      for (const button of [...buttons]) {
        if (!button.isConnected) {
          buttons.delete(button);
          continue;
        }
        const enabled = this.ctx.mapLayers[key] === true;
        const relayPending = this.isRelayPendingLayer(key);
        const runtimeUnavailable = this.isRuntimeUnavailableLayer(key);
        button.setAttribute('aria-pressed', enabled && !relayPending ? 'true' : 'false');
        button.disabled = !this.canToggleLayer(key);
        if (runtimeUnavailable) {
          button.title = 'Live AIS and aggregate maritime traffic are currently unavailable';
          button.setAttribute('aria-label', `${key === 'ais' ? 'Ships' : sentence(key)} layer unavailable`);
        } else if (key === 'ais') {
          button.removeAttribute('title');
          button.setAttribute('aria-label', 'Toggle Ships layer');
        }
        const state = button.querySelector<HTMLElement>('.ops-layer-state');
        if (state) state.textContent = relayPending
          ? 'pending'
          : runtimeUnavailable
            ? 'unavailable'
          : enabled
            ? 'ON'
          : !VANTAGE_PUBLIC_MODE && state.dataset.locked === 'true'
            ? 'PRO'
            : '';
      }
    }

    if (this.moreLayersButton) {
      const active = this.getAvailableLayerDefinitions().filter((definition) => (
        this.ctx.mapLayers[definition.key]
          && !this.isRelayPendingLayer(definition.key)
          && !this.isRuntimeUnavailableLayer(definition.key)
      )).length;
      this.moreLayersButton.textContent = active > 0 ? `Layers ${active}` : 'Layers';
    }
    if (this.countAir && !this.countAir.hidden) {
      const militaryFlights = this.ctx.intelligenceCache.military?.flights?.length ?? 0;
      setCount(this.countAir, militaryFlights, 'air');
    }
    const ais = safeAisStatus();
    if (this.countShips && !this.countShips.hidden) {
      if (ais.availability === 'traffic') setCount(this.countShips, ais.zones, 'maritime zones');
      else if (ais.availability === 'unavailable') this.countShips.textContent = 'ships unavailable';
      else setCount(this.countShips, ais.vessels, 'ships');
    }
    this.updateStatusLine();
  }

  /** Search-result bridge: hidden classic news panels cannot be scrolled in ops mode. */
  inspectNewsItem(item: NewsItem): void {
    const match = this.collectFeedItems(false).find((candidate) => (
      candidate.link === item.link || candidate.allItems.some((entry) => entry.link === item.link)
    ));
    this.inspectFeedItem(match ?? feedItemFromNews(item));
  }

  /** Search-result bridge for result types that previously only scrolled hidden panels. */
  inspectSearchResult(result: OpsSearchSummary): void {
    this.selection = { kind: 'search', result };
    this.setFocus(null);
    const content = this.beginInspector(result.type === 'market' ? 'Market signal' : 'Prediction', result.title, result.subtitle);
    const note = el('p', 'ops-inspector-copy');
    note.textContent = result.type === 'market'
      ? 'Current market context from the live intelligence index.'
      : 'Current prediction-market context from the live intelligence index.';
    content.appendChild(note);
    this.openInspector();
  }

  // ---- construction ----

  private buildTopBar(): HTMLElement {
    const top = el('header', 'ops-top');

    const brand = el('div', 'ops-brand');
    brand.textContent = BRAND.name;
    this.systemStatus = el('span', 'ops-live');
    this.systemStatus.textContent = navigator.onLine ? 'Updating' : 'Offline';
    this.systemStatus.dataset.state = navigator.onLine ? 'updating' : 'offline';
    brand.appendChild(this.systemStatus);

    const chips = el('div', 'ops-chips');
    for (const definition of PRIMARY_LAYER_CHIPS) {
      if (VANTAGE_PUBLIC_MODE && !VANTAGE_RELAY_ENABLED
        && (definition.key === 'military' || definition.key === 'ais')) continue;
      chips.appendChild(this.createPrimaryLayerChip(definition));
    }

    this.moreLayersButton = el('button', 'ops-more-layers') as HTMLButtonElement;
    this.moreLayersButton.type = 'button';
    this.moreLayersButton.textContent = 'Layers';
    this.moreLayersButton.setAttribute('aria-haspopup', 'dialog');
    this.moreLayersButton.setAttribute('aria-expanded', 'false');
    this.moreLayersButton.setAttribute('aria-controls', 'opsLayerPopover');
    this.moreLayersButton.addEventListener('click', () => this.toggleLayerPopover());

    this.layerPopover = el('div', 'ops-layer-popover');
    this.layerPopover.id = 'opsLayerPopover';
    this.layerPopover.hidden = true;
    this.layerPopover.setAttribute('role', 'dialog');
    this.layerPopover.setAttribute('aria-label', 'Map layers');

    const divider = el('span', 'ops-top-divider');
    divider.setAttribute('aria-hidden', 'true');

    const timeSeg = el('div', 'ops-seg');
    for (const range of TIME_RANGES) {
      const button = el('button', 'ops-seg-btn') as HTMLButtonElement;
      button.type = 'button';
      button.textContent = range === 'all' ? 'All' : range.toUpperCase();
      button.setAttribute('aria-label', `Show ${range === 'all' ? 'all available' : `the last ${range}`} activity`);
      button.addEventListener('click', () => this.ctx.map?.setTimeRange(range));
      timeSeg.appendChild(button);
      this.registerTimeButton(range, button);
    }

    const right = el('div', 'ops-top-right');
    this.briefButton = el('button', 'ops-brief-button') as HTMLButtonElement;
    this.briefButton.type = 'button';
    this.briefButton.textContent = 'Brief';
    this.briefButton.setAttribute('aria-label', 'Open cited situation brief');
    this.briefButton.addEventListener('click', () => { void this.inspectBrief(); });
    const counts = el('div', 'ops-counts');
    this.countAir = el('span');
    this.countShips = el('span');
    this.countEvents = el('span');
    counts.append(this.countAir, this.countShips, this.countEvents);
    if (VANTAGE_PUBLIC_MODE) right.appendChild(this.briefButton);
    right.appendChild(counts);
    right.id = 'opsTopRight';

    top.append(brand, chips, this.moreLayersButton, divider, timeSeg, right, this.layerPopover);
    return top;
  }

  private createPrimaryLayerChip(definition: LayerChipDef): HTMLButtonElement {
    const button = el('button', 'ops-chip') as HTMLButtonElement;
    button.type = 'button';
    button.style.setProperty('--chip-color', `var(${definition.cssVar})`);
    const relayPending = VANTAGE_PUBLIC_MODE
      && !VANTAGE_RELAY_ENABLED
      && (definition.key === 'military' || definition.key === 'ais');
    button.setAttribute('aria-label', relayPending
      ? `${definition.label} layer pending relay provisioning`
      : `Toggle ${definition.label} layer`);
    if (relayPending) button.title = 'Available after the always-on relay is provisioned';
    const dot = el('span', 'dot');
    button.append(dot, document.createTextNode(definition.label));
    button.addEventListener('click', () => this.toggleLayer(definition.key));
    this.registerLayerButton(definition.key, button);
    return button;
  }

  private buildBody(): HTMLElement {
    const body = el('main', 'ops-body');
    body.id = 'opsMain';
    body.tabIndex = -1;
    this.body = body;

    const feed = el('aside', 'ops-feed');
    feed.setAttribute('aria-label', 'Live intelligence feed');
    const head = el('div', 'ops-feed-head');
    const label = el('span');
    label.textContent = 'Intelligence';
    const headRight = el('span', 'ops-feed-head-right');
    const order = el('span', 'ops-feed-order');
    order.setAttribute('role', 'group');
    order.setAttribute('aria-label', 'Feed order');
    for (const mode of ['priority', 'latest'] as const) {
      const button = el('button', 'ops-feed-order-button') as HTMLButtonElement;
      button.type = 'button';
      button.textContent = sentence(mode);
      button.title = mode === 'priority'
        ? 'Rank by current brief, severity, outlet diversity and freshness'
        : 'Show newest reporting first';
      button.addEventListener('click', () => {
        this.feedOrder = mode;
        this.syncFeedOrderButtons();
        this.renderFeed();
      });
      this.feedOrderButtons.set(mode, button);
      order.appendChild(button);
    }
    this.watchBell = el('button', 'ops-watch-bell') as HTMLButtonElement;
    this.watchBell.type = 'button';
    this.watchBell.textContent = 'Alerts';
    this.watchBell.setAttribute('aria-label', 'Watchlist alert settings');
    this.watchBell.setAttribute('aria-pressed', 'false');
    this.watchBell.addEventListener('click', () => {
      this.watchSettingsOpen = !this.watchSettingsOpen;
      this.renderWatchlistStrip();
    });
    this.feedCount = el('span', 'count');
    headRight.append(order, this.watchBell, this.feedCount);
    head.append(label, headRight);
    this.syncFeedOrderButtons();
    this.briefPreviewHost = el('div', 'ops-brief-preview-host');
    this.watchlistRow = el('div', 'ops-watchlist');
    this.watchlistRow.hidden = true;
    this.feedList = el('div', 'ops-feed-list');
    feed.append(head, this.briefPreviewHost, this.watchlistRow, this.feedList);

    const mapArea = el('section', 'ops-map');
    mapArea.id = 'opsMapArea';
    mapArea.setAttribute('aria-label', 'Global intelligence map');
    mapArea.appendChild(this.buildHud());
    const controls = el('div', 'ops-map-controls');
    controls.id = 'opsMapControls';
    mapArea.appendChild(controls);

    this.inspector = el('aside', 'ops-inspector');
    this.inspector.id = 'opsInspector';
    this.inspector.hidden = true;
    this.inspector.setAttribute('aria-label', 'Intelligence inspector');

    body.append(feed, mapArea, this.inspector);
    return body;
  }

  private buildHud(): HTMLElement {
    // Compact escalation chip: "Escalation {score} · {level}". Clicking it
    // opens the full breakdown inspector (contributors, regions, trend).
    const hud = el('button', 'ops-hud') as HTMLButtonElement;
    hud.type = 'button';
    hud.setAttribute('aria-label', 'Escalation index breakdown');
    hud.addEventListener('click', () => this.inspectEscalation());
    const label = el('span', 'ops-hud-label');
    label.textContent = 'Escalation';
    this.hudScore = el('b', 'ops-hud-score');
    this.hudScore.textContent = '--';
    this.hudLevel = el('span', 'ops-hud-level');
    this.hudLevel.textContent = 'Pending';
    hud.append(label, this.hudScore, document.createTextNode('·'), this.hudLevel);
    return hud;
  }

  private buildBottomBar(): HTMLElement {
    const bottom = el('footer', 'ops-bottom');
    this.statusLine = el('span', 'ops-status-item');

    const timeline = el('div', 'ops-timeline');
    const timelineLabel = el('span', 'ops-timeline-label');
    timelineLabel.textContent = 'Activity';
    this.timelineBars = el('div', 'ops-timeline-bars');
    this.timelineBars.setAttribute('aria-label', 'Activity timeline');
    this.timelineMeta = el('span', 'ops-timeline-meta');
    timeline.append(timelineLabel, this.timelineBars, this.timelineMeta);

    const help = el('button', 'ops-help-btn') as HTMLButtonElement;
    help.type = 'button';
    help.textContent = '?';
    help.setAttribute('aria-label', 'Show keyboard shortcuts');
    help.addEventListener('click', () => this.toggleShortcuts(true));

    bottom.append(this.statusLine, timeline, help);
    return bottom;
  }

  private buildShortcutsOverlay(): HTMLElement {
    const overlay = el('div', 'ops-shortcuts-overlay');
    overlay.hidden = true;
    overlay.setAttribute('role', 'presentation');
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) this.toggleShortcuts(false);
    });

    const dialog = el('section', 'ops-shortcuts');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'opsShortcutsTitle');
    const head = el('div', 'ops-shortcuts-head');
    const title = el('h2');
    title.id = 'opsShortcutsTitle';
    title.textContent = 'Keyboard shortcuts';
    const close = iconButton('×', 'Close keyboard shortcuts', () => this.toggleShortcuts(false));
    head.append(title, close);
    const grid = el('div', 'ops-shortcuts-grid');
    const shortcuts: Array<[string, string]> = [
      ['⌘/Ctrl K or /', 'Search intelligence'],
      ['J / K', 'Move through live feed'],
      ['Enter', 'Inspect selected item'],
      ['L', 'Open map layers'],
      ['Esc', 'Close the active surface'],
      ['?', 'Show this reference'],
    ];
    for (const [keys, action] of shortcuts) {
      const key = el('kbd');
      key.textContent = keys;
      const description = el('span');
      description.textContent = action;
      grid.append(key, description);
    }
    dialog.append(head, grid);
    overlay.appendChild(dialog);
    this.shortcutsOverlay = overlay;
    return overlay;
  }

  // ---- adopted legacy elements ----

  private prepareLandmarks(): void {
    this.legacyMain = document.getElementById('main');
    if (this.legacyMain) {
      this.legacyMainRole = this.legacyMain.getAttribute('role');
      this.legacyMainAriaHidden = this.legacyMain.getAttribute('aria-hidden');
      this.legacyMainWasInert = this.legacyMain.inert;
      this.legacyMainWasHidden = this.legacyMain.hidden;
      this.legacyMain.setAttribute('role', 'presentation');
      this.legacyMain.setAttribute('aria-hidden', 'true');
      this.legacyMain.inert = true;
      this.legacyMain.hidden = true;
    }

    this.skipLink = document.querySelector<HTMLAnchorElement>('.skip-link');
    if (this.skipLink) {
      this.skipLinkHref = this.skipLink.getAttribute('href') ?? '';
      this.skipLinkText = this.skipLink.textContent ?? '';
      this.skipLink.href = '#opsMain';
      this.skipLink.textContent = 'Skip to intelligence workspace';
      this.boundSkipClick = (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.body?.focus();
      };
      this.skipLink.addEventListener('click', this.boundSkipClick, true);
    }
  }

  private restoreLandmarks(): void {
    if (this.legacyMain) {
      if (this.legacyMainRole === null) this.legacyMain.removeAttribute('role');
      else this.legacyMain.setAttribute('role', this.legacyMainRole);
      if (this.legacyMainAriaHidden === null) this.legacyMain.removeAttribute('aria-hidden');
      else this.legacyMain.setAttribute('aria-hidden', this.legacyMainAriaHidden);
      this.legacyMain.inert = this.legacyMainWasInert;
      this.legacyMain.hidden = this.legacyMainWasHidden;
    }
    if (this.skipLink) {
      if (this.boundSkipClick) this.skipLink.removeEventListener('click', this.boundSkipClick, true);
      this.skipLink.setAttribute('href', this.skipLinkHref);
      this.skipLink.textContent = this.skipLinkText;
    }
    this.boundSkipClick = null;
    this.legacyMain = null;
    this.skipLink = null;
  }

  private dockLegacyPanels(): void {
    const dock = el('div', 'ops-panel-dock');
    dock.setAttribute('aria-hidden', 'true');
    const mobilePanelNav = document.querySelector<HTMLElement>('.mobile-panel-nav');
    if (mobilePanelNav) dock.appendChild(mobilePanelNav);
    for (const id of ['panelTabsMount', 'panelsGrid', 'mapBottomGrid']) {
      const node = document.getElementById(id);
      if (node) dock.appendChild(node);
    }
    document.body.appendChild(dock);
    this.panelDock = dock;
  }

  private adoptMap(): void {
    const mapSection = document.getElementById('mapSection');
    const mapArea = this.root?.querySelector('.ops-map');
    if (mapSection && mapArea) mapArea.appendChild(mapSection);
  }

  private adoptHeaderControls(): void {
    const right = this.root?.querySelector('.ops-top-right');
    if (right) {
      const controlIds = VANTAGE_PUBLIC_MODE
        ? ['headerClock', 'searchBtn']
        : ['headerClock', 'searchBtn', 'unifiedSettingsMount', 'authWidgetMount'];
      for (const id of controlIds) {
        const node = document.getElementById(id);
        if (node) right.appendChild(node);
      }
    }
    const controls = this.root?.querySelector('.ops-map-controls');
    const dimToggle = document.getElementById('mapDimensionToggle');
    if (controls && dimToggle) controls.appendChild(dimToggle);
  }

  // ---- interaction wiring ----

  private installInteractionHandlers(): void {
    this.boundKeydown = (event) => this.handleKeydown(event);
    document.addEventListener('keydown', this.boundKeydown);

    this.boundOutsidePointer = (event) => {
      const target = event.target as Node | null;
      if (!target || this.layerPopover?.hidden) return;
      if (this.layerPopover?.contains(target) || this.moreLayersButton?.contains(target)) return;
      this.toggleLayerPopover(false);
    };
    document.addEventListener('pointerdown', this.boundOutsidePointer);

    this.boundOpsAlert = (event) => {
      const alert = (event as CustomEvent<BreakingAlert>).detail;
      if (alert) this.inspectAlert(alert);
    };
    document.addEventListener('wm:ops-inspect-alert', this.boundOpsAlert);
  }

  private handleKeydown(event: KeyboardEvent): void {
    const shortcuts = this.shortcutsOverlay;
    if (shortcuts && !shortcuts.hidden && event.key === 'Tab') {
      trapFocus(event, shortcuts);
      return;
    }
    const target = event.target as HTMLElement | null;
    if (isEditableTarget(target)) return;

    if (event.key === 'Escape') {
      if (!this.shortcutsOverlay?.hidden) {
        event.preventDefault();
        this.toggleShortcuts(false);
      } else if (!this.layerPopover?.hidden) {
        event.preventDefault();
        this.toggleLayerPopover(false);
      } else if (this.selection) {
        event.preventDefault();
        this.closeInspector();
      }
      return;
    }

    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === '/') {
      event.preventDefault();
      this.hooks.onOpenSearch();
    } else if (event.key.toLowerCase() === 'j') {
      event.preventDefault();
      this.moveFeedFocus(1);
    } else if (event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.moveFeedFocus(-1);
    } else if (event.key.toLowerCase() === 'l') {
      event.preventDefault();
      this.toggleLayerPopover();
    } else if (event.key === '?') {
      event.preventDefault();
      this.toggleShortcuts(true);
    }
  }

  private moveFeedFocus(delta: number): void {
    const buttons = [...(this.feedList?.querySelectorAll<HTMLButtonElement>('.ops-feed-item') ?? [])];
    if (buttons.length === 0) return;
    const activeElement = document.activeElement;
    const activeIndex = activeElement instanceof HTMLButtonElement ? buttons.indexOf(activeElement) : -1;
    const selectedIndex = buttons.findIndex((button) => button.getAttribute('aria-current') === 'true');
    const origin = activeIndex >= 0 ? activeIndex : selectedIndex >= 0 ? selectedIndex : delta > 0 ? -1 : 0;
    const next = (origin + delta + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  // ---- layer controls ----

  private registerLayerButton(key: keyof MapLayers, button: HTMLButtonElement): void {
    const buttons = this.chipButtons.get(key) ?? new Set<HTMLButtonElement>();
    buttons.add(button);
    this.chipButtons.set(key, buttons);
  }

  private registerTimeButton(range: TimeRange, button: HTMLButtonElement): void {
    const buttons = this.timeButtons.get(range) ?? new Set<HTMLButtonElement>();
    buttons.add(button);
    this.timeButtons.set(range, buttons);
  }

  private currentRenderer(): MapRenderer {
    return this.ctx.map?.isGlobeMode?.() ? 'globe' : 'flat';
  }

  private getAvailableLayerDefinitions(): LayerDefinition[] {
    const renderer = this.currentRenderer();
    return getLayersForVariant((SITE_VARIANT || 'full') as MapVariant, renderer)
      .filter((definition) => isPublicVantageCapability(definition.premium))
      .filter((definition) => isLayerExecutable(
        definition.key,
        renderer,
        this.ctx.map?.isDeckGLActive?.() ?? false,
      ));
  }

  private canToggleLayer(key: keyof MapLayers): boolean {
    if (this.isRelayPendingLayer(key)) return false;
    if (this.isRuntimeUnavailableLayer(key) && !this.ctx.mapLayers[key]) return false;
    return isLayerCommandAllowed(
      key,
      this.ctx.mapLayers[key],
      this.currentRenderer(),
      this.ctx.map?.isDeckGLActive?.() ?? false,
      !VANTAGE_PUBLIC_MODE && hasPremiumAccess(getAuthState()),
    );
  }

  private isRelayPendingLayer(key: keyof MapLayers): boolean {
    return VANTAGE_PUBLIC_MODE && !VANTAGE_RELAY_ENABLED && (key === 'military' || key === 'ais');
  }

  private isRuntimeUnavailableLayer(key: keyof MapLayers): boolean {
    return key === 'ais' && safeAisStatus().availability === 'unavailable';
  }

  private toggleLayer(key: keyof MapLayers): void {
    if (!this.canToggleLayer(key)) return;
    this.hooks.onToggleLayer(key, !this.ctx.mapLayers[key]);
    this.syncLayerChips();
  }

  private toggleLayerPopover(force?: boolean): void {
    if (!this.layerPopover || !this.moreLayersButton) return;
    const open = force ?? this.layerPopover.hidden;
    if (open) {
      this.layerReturnFocus = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : this.moreLayersButton;
      this.renderLayerPopover();
    }
    this.layerPopover.hidden = !open;
    this.moreLayersButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      this.layerPopover.querySelector<HTMLButtonElement>('.ops-layer-option')?.focus();
    } else if (this.layerReturnFocus?.isConnected) {
      const restore = this.layerReturnFocus;
      this.layerReturnFocus = null;
      requestAnimationFrame(() => restore.focus());
    }
  }

  private renderLayerPopover(): void {
    if (!this.layerPopover) return;
    const header = el('div', 'ops-layer-popover-head');
    const title = el('div');
    title.textContent = `Map layers · ${sentence(this.currentRenderer())}`;
    const close = iconButton('×', 'Close map layers', () => this.toggleLayerPopover(false));
    header.append(title, close);

    const grid = el('div', 'ops-layer-grid');
    for (const definition of this.getAvailableLayerDefinitions()) {
      const button = el('button', 'ops-layer-option') as HTMLButtonElement;
      button.type = 'button';
      button.setAttribute('aria-pressed', this.ctx.mapLayers[definition.key] ? 'true' : 'false');
      button.disabled = !this.canToggleLayer(definition.key);
      button.addEventListener('click', () => this.toggleLayer(definition.key));
      const dot = el('span', 'ops-layer-option-dot');
      const label = el('span', 'ops-layer-option-label');
      label.textContent = definition.fallbackLabel;
      const state = el('span', 'ops-layer-state');
      state.dataset.locked = definition.premium === 'locked' ? 'true' : 'false';
      button.append(dot, label, state);
      grid.appendChild(button);
      this.registerLayerButton(definition.key, button);
    }

    const windowControl = el('div', 'ops-layer-window');
    const windowLabel = el('span', 'ops-layer-window-label');
    windowLabel.textContent = 'Activity window';
    const windowButtons = el('div', 'ops-layer-window-buttons');
    for (const range of TIME_RANGES) {
      const button = el('button', 'ops-seg-btn ops-layer-time-btn') as HTMLButtonElement;
      button.type = 'button';
      button.textContent = range === 'all' ? 'All' : range.toUpperCase();
      button.setAttribute('aria-label', `Show ${range === 'all' ? 'all available' : `the last ${range}`} activity`);
      button.addEventListener('click', () => this.ctx.map?.setTimeRange(range));
      this.registerTimeButton(range, button);
      windowButtons.appendChild(button);
    }
    windowControl.append(windowLabel, windowButtons);
    this.layerPopover.replaceChildren(header, windowControl, grid);
    this.syncLayerChips();
    this.syncTimeChips(this.ctx.map?.getTimeRange() ?? this.ctx.currentTimeRange);
  }

  // ---- live feed + timeline ----

  private collectFeedItems(applyWindow = true): OpsFeedItem[] {
    const clusters = this.ctx.latestClusters;
    const items = clusters.length > 0
      ? clusters.map((cluster: ClusteredEvent): OpsFeedItem => ({
          // A cluster id includes the first story timestamp, so it can change
          // when a feed republishes or the cluster membership shifts. Base new
          // share links on the primary source URL instead; keep the cluster id
          // as a compatibility alias for links copied by earlier builds.
          id: `news:${stableHash(cluster.primaryLink || cluster.primaryTitle)}`,
          legacyFocusId: `cluster:${cluster.id}`,
          title: cluster.primaryTitle,
          source: cluster.primarySource,
          link: cluster.primaryLink,
          when: coerceDate(cluster.lastUpdated),
          alert: cluster.isAlert,
          sourceCount: Math.max(cluster.sourceCount, cluster.allItems.length, 1),
          topSources: cluster.topSources.map((source) => ({ name: source.name, url: source.url })),
          allItems: cluster.allItems,
          ...(cluster.lat !== undefined && { lat: cluster.lat }),
          ...(cluster.lon !== undefined && { lon: cluster.lon }),
          locationName: cluster.allItems.find((item) => item.locationName)?.locationName,
          snippet: cluster.allItems.find((item) => item.link === cluster.primaryLink)?.snippet
            ?? cluster.allItems.find((item) => item.snippet)?.snippet,
          ...(cluster.threat && { threat: cluster.threat }),
        }))
      : this.ctx.allNews.map(feedItemFromNews);

    const latest = items.sort((a, b) => b.when.getTime() - a.when.getTime());
    if (!applyWindow) return latest;
    const range = this.ctx.map?.getTimeRange() ?? this.ctx.currentTimeRange;
    const duration = TIME_RANGE_MS[range];
    const windowed = duration === undefined
      ? latest
      : latest.filter((item) => item.when.getTime() >= Date.now() - duration);
    // The active watchlist chip narrows the already time-windowed feed.
    const filter = this.watchFilter;
    const filtered = filter
      ? windowed.filter((item) => watchEntryMatches(item, filter.kind, filter.value))
      : windowed;
    const brief = this.currentBrief();
    const watchlist = getWatchlist();
    const ordered = this.feedOrder === 'priority'
      ? [...filtered].sort((a, b) => priorityScore(b, brief, watchlist) - priorityScore(a, brief, watchlist)
        || b.when.getTime() - a.when.getTime())
      : filtered;
    return ordered.slice(0, FEED_LIMIT);
  }

  private renderFeed(): void {
    if (!this.feedList) return;
    const focusedId = document.activeElement instanceof HTMLButtonElement
      && this.feedList.contains(document.activeElement)
      ? document.activeElement.dataset.focusId ?? null
      : null;
    const brief = this.currentBrief();
    this.renderBriefPreview(brief);
    const items = this.collectFeedItems(true);
    this.feedList.replaceChildren();
    this.feedList.removeAttribute('aria-busy');
    if (this.feedCount) this.feedCount.textContent = `${items.length} shown`;

    if (items.length === 0 && !this.feedHasSettled) {
      if (this.feedCount) this.feedCount.textContent = 'Updating';
      this.feedList.setAttribute('aria-busy', 'true');
      this.feedList.appendChild(feedLoadingState());
      this.renderTimeline(items);
      return;
    }

    if (items.length === 0) {
      const empty = el('div', 'ops-feed-empty');
      empty.textContent = 'No reporting in this time window.';
      this.feedList.appendChild(empty);
      this.renderTimeline(items);
      return;
    }

    const selectedId = this.selection?.kind === 'feed' ? this.selection.item.id : null;
    for (const item of items) {
      const button = el('button', 'ops-feed-item') as HTMLButtonElement;
      button.type = 'button';
      button.dataset.focusId = item.id;
      const briefLead = isBriefLead(item, brief);
      if (briefLead) button.dataset.briefLead = 'true';
      if (item.id === selectedId) button.setAttribute('aria-current', 'true');
      const meta = el('div', 'meta');
      if (briefLead) {
        const signal = el('span', 'ops-feed-signal');
        signal.textContent = 'Brief lead';
        meta.appendChild(signal);
      }
      const source = el('span', 'src');
      source.textContent = item.source;
      const when = el('span');
      when.textContent = formatTimeAgo(item.when);
      const corroboration = el('span', 'corroboration');
      corroboration.textContent = item.sourceCount > 1 ? `${item.sourceCount} outlets` : '';
      meta.append(source, when, corroboration);
      const title = el('div', 'title');
      title.textContent = item.title;
      button.append(meta, title);
      button.addEventListener('click', () => this.inspectFeedItem(item));
      this.feedList.appendChild(button);
    }

    this.renderTimeline([...items].sort((a, b) => b.when.getTime() - a.when.getTime()));
    if (focusedId) {
      this.feedList.querySelector<HTMLButtonElement>(`[data-focus-id="${cssEscape(focusedId)}"]`)?.focus();
    }
    const focus = this.ctx.opsFocus;
    if (!this.selection && focus) {
      const selected = items.find((item) => item.id === focus || item.legacyFocusId === focus);
      if (selected) this.inspectFeedItem(selected, false);
    }
  }

  private currentBrief(): VantageSynthesis | null {
    const insights = getServerInsights();
    if (!insights) return null;
    try {
      return buildVantageSynthesis(insights);
    } catch {
      return null;
    }
  }

  private renderBriefPreview(brief: VantageSynthesis | null): void {
    if (!this.briefPreviewHost) return;
    if (this.systemStatus) {
      const newestReport = brief ? null : this.collectFeedItems(false)[0] ?? null;
      const state = !navigator.onLine ? 'offline' : brief || newestReport ? 'current' : 'updating';
      this.systemStatus.dataset.state = state;
      this.systemStatus.textContent = state === 'offline'
        ? 'Offline'
        : brief
          ? `Brief ${brief.freshness.replace(/^Updated\s+/i, '')}`
          : newestReport
            ? `Reports ${formatTimeAgo(newestReport.when)}`
            : 'Updating';
    }
    if (!VANTAGE_PUBLIC_MODE || !brief) {
      this.briefPreviewButton?.remove();
      this.briefPreviewButton = null;
      return;
    }

    let button = this.briefPreviewButton;
    if (!button) {
      button = el('button', 'ops-brief-preview') as HTMLButtonElement;
      button.type = 'button';
      button.setAttribute('aria-label', 'Open the current cited situation brief');
      button.addEventListener('click', () => { void this.inspectBrief(); });
      this.briefPreviewButton = button;
      this.briefPreviewHost.appendChild(button);
    }
    const meta = el('span', 'ops-brief-preview-meta');
    const label = el('span', 'ops-brief-preview-label');
    label.textContent = brief.generationMode === 'ai' ? 'Cited synthesis' : 'Cited brief';
    const freshness = el('span');
    freshness.textContent = brief.freshness;
    meta.append(label, freshness);
    const summary = el('span', 'ops-brief-preview-copy');
    summary.textContent = stripCitations(brief.whatChanged);
    const evidence = el('span', 'ops-brief-preview-evidence');
    evidence.textContent = `${brief.sources.length} cited reports · ${corroborationLabel(brief)}`;
    button.replaceChildren(meta, summary, evidence);
  }

  private syncFeedOrderButtons(): void {
    for (const [mode, button] of this.feedOrderButtons) {
      button.setAttribute('aria-pressed', mode === this.feedOrder ? 'true' : 'false');
    }
  }

  private renderTimeline(items: OpsFeedItem[]): void {
    if (!this.timelineBars || !this.timelineMeta) return;
    this.timelineBars.replaceChildren();
    const now = Date.now();
    const range = this.ctx.map?.getTimeRange() ?? this.ctx.currentTimeRange;
    const oldest = items[items.length - 1]?.when.getTime() ?? now - 60 * 60_000;
    // The feed is capped at FEED_LIMIT newest items, which usually span far
    // less than the selected time range — bucketing across the nominal range
    // would pile everything into the last bar. Bucket across the actual data
    // span instead (floored at 1h, capped at the range).
    const dataSpan = Math.max(60 * 60_000, now - oldest);
    const duration = Math.min(TIME_RANGE_MS[range] ?? dataSpan, dataSpan);
    const start = now - duration;
    const buckets: OpsFeedItem[][] = Array.from({ length: TIMELINE_BUCKETS }, () => []);
    for (const item of items) {
      const fraction = Math.max(0, Math.min(0.999999, (item.when.getTime() - start) / duration));
      buckets[Math.floor(fraction * TIMELINE_BUCKETS)]?.push(item);
    }
    const max = Math.max(1, ...buckets.map((bucket) => bucket.length));
    const bucketDuration = duration / TIMELINE_BUCKETS;

    buckets.forEach((bucket, index) => {
      const button = el('button', 'ops-timeline-bar') as HTMLButtonElement;
      button.type = 'button';
      const height = bucket.length === 0 ? 0.08 : 0.18 + (bucket.length / max) * 0.82;
      button.style.setProperty('--activity', String(height));
      const bucketStart = new Date(start + index * bucketDuration);
      const bucketEnd = new Date(start + (index + 1) * bucketDuration);
      button.setAttribute('aria-label', `${bucket.length} reports from ${formatTimelineDate(bucketStart)} to ${formatTimelineDate(bucketEnd)}`);
      button.title = `${bucket.length} reports · ${formatTimelineDate(bucketStart)}`;
      button.disabled = bucket.length === 0;
      if (bucket[0]) button.addEventListener('click', () => this.inspectFeedItem(bucket[0]!));
      this.timelineBars?.appendChild(button);
    });
    const spanHours = duration / 3_600_000;
    const spanLabel = spanHours < 48 ? `${Math.max(1, Math.round(spanHours))}h` : `${Math.round(spanHours / 24)}d`;
    this.timelineMeta.textContent = `${items.length} reports · last ${spanLabel}`;
  }

  // ---- inspector ----

  private inspectFeedItem(item: OpsFeedItem, updateUrl = true): void {
    this.selection = { kind: 'feed', item };
    if (updateUrl) this.setFocus(item.id);
    // User-initiated inspection (feed row or timeline bar click) also flies the
    // map to the report; passive restores (deep links, data refreshes) do not.
    if (updateUrl && item.lat !== undefined && item.lon !== undefined) {
      this.ctx.map?.setCenter(item.lat, item.lon, 5);
      if (!prefersReducedMotion()) this.ctx.map?.flashLocation(item.lat, item.lon, 1800);
    }
    const content = this.beginInspector(
      item.alert ? 'Priority report' : 'Intelligence report',
      item.title,
      `${item.source} · ${formatTimeAgo(item.when)}`,
    );

    const badges = el('div', 'ops-inspector-badges');
    if (item.threat) badges.appendChild(badge(sentence(item.threat.level), `level-${item.threat.level}`));
    if (item.sourceCount > 1) badges.appendChild(badge(`${item.sourceCount} outlets`, 'sources'));
    if (item.locationName) badges.appendChild(badge(item.locationName, 'location'));
    if (badges.childElementCount > 0) content.appendChild(badges);

    if (this.feedOrder === 'priority') {
      const ranking = el('p', 'ops-rank-reason');
      ranking.textContent = `Priority basis: ${priorityReasons(item, this.currentBrief(), getWatchlist()).join(', ')}.`;
      content.appendChild(ranking);
    }

    const summary = el('p', 'ops-inspector-copy');
    summary.textContent = item.snippet || 'Open the source report for the full context and verify material claims against corroborating evidence.';
    content.appendChild(summary);

    const facts = el('div', 'ops-inspector-facts');
    facts.append(
      fact('Updated', formatAbsoluteTime(item.when)),
      fact('Outlets', String(item.sourceCount)),
      fact('Signal', item.threat?.category ? sentence(item.threat.category) : (item.alert ? 'Priority' : 'Reporting')),
      fact('Confidence', item.threat ? `${Math.round(item.threat.confidence * 100)}%` : 'Unscored'),
    );
    content.appendChild(facts);

    const sources = uniqueSources(item);
    if (sources.length > 0) {
      const evidenceTitle = el('h3', 'ops-inspector-section-title');
      evidenceTitle.textContent = 'Evidence sources';
      const list = el('div', 'ops-source-list');
      for (const source of sources.slice(0, 6)) {
        const link = el('a', 'ops-source-link') as HTMLAnchorElement;
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = source.name;
        list.appendChild(link);
      }
      content.append(evidenceTitle, list);
    }

    const actions = el('div', 'ops-inspector-actions');
    if (item.lat !== undefined && item.lon !== undefined) {
      actions.appendChild(actionButton('Locate on map', () => {
        this.ctx.map?.setCenter(item.lat!, item.lon!, 6);
        this.ctx.map?.flashLocation(item.lat!, item.lon!, 1800);
      }, true));
    }
    const open = el('a', 'ops-inspector-action') as HTMLAnchorElement;
    open.href = item.link;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.textContent = 'Open original ↗';
    actions.appendChild(open);
    actions.appendChild(actionButton('Copy deep link', (button) => this.copyCurrentUrl(button)));
    const topic = deriveWatchTopic(item);
    if (topic) {
      const watchButton = actionButton('', (button) => {
        toggleTopic(topic);
        syncWatchButton(button, 'topic', topic);
      });
      syncWatchButton(watchButton, 'topic', topic);
      actions.appendChild(watchButton);
    }
    content.appendChild(actions);
    this.openInspector();
    this.syncFeedSelection();
  }

  private inspectHotspot(hotspot: Hotspot): void {
    this.selection = { kind: 'hotspot', hotspot };
    this.setFocus(`hotspot:${hotspot.id}`);
    const content = this.beginInspector(
      'Intelligence hotspot',
      hotspot.name,
      hotspot.location || hotspot.subtext || `${hotspot.lat.toFixed(2)}, ${hotspot.lon.toFixed(2)}`,
    );
    const badges = el('div', 'ops-inspector-badges');
    badges.appendChild(badge(sentence(hotspot.level ?? 'low'), `level-${hotspot.level ?? 'low'}`));
    if (hotspot.escalationScore) badges.appendChild(badge(`Escalation ${hotspot.escalationScore}/5`, 'sources'));
    if (hotspot.status) badges.appendChild(badge(sentence(hotspot.status), 'location'));
    content.appendChild(badges);

    const description = el('p', 'ops-inspector-copy');
    description.textContent = hotspot.description || hotspot.whyItMatters || 'Monitored geopolitical hotspot. Use the live feed and map popup to verify current reporting.';
    content.appendChild(description);

    if (hotspot.whyItMatters && hotspot.whyItMatters !== description.textContent) {
      const heading = el('h3', 'ops-inspector-section-title');
      heading.textContent = 'Why it matters';
      const copy = el('p', 'ops-inspector-copy');
      copy.textContent = hotspot.whyItMatters;
      content.append(heading, copy);
    }

    if (hotspot.escalationIndicators?.length) {
      const heading = el('h3', 'ops-inspector-section-title');
      heading.textContent = 'Escalation indicators';
      const list = el('ul', 'ops-indicator-list');
      for (const indicator of hotspot.escalationIndicators) {
        const item = el('li');
        item.textContent = indicator;
        list.appendChild(item);
      }
      content.append(heading, list);
    }

    const actions = el('div', 'ops-inspector-actions');
    actions.append(
      actionButton('Center map', () => this.ctx.map?.setCenter(hotspot.lat, hotspot.lon, 5), true),
      actionButton('Copy deep link', (button) => this.copyCurrentUrl(button)),
    );
    content.appendChild(actions);
    this.openInspector();
    const related = this.findFeedItemForHotspot(hotspot);
    if (related) this.highlightFeedRow(related);
  }

  /**
   * Hotspot → feed correlation for the map → inspector → feed loop. Feed rows
   * never carry hotspot ids (their legacyFocusId is cluster-based), so try the
   * deep-link id first, then location/name text, then geographic proximity.
   */
  private findFeedItemForHotspot(hotspot: Hotspot): OpsFeedItem | null {
    const items = this.collectFeedItems(true);
    const focusId = `hotspot:${hotspot.id}`;
    const byId = items.find((item) => item.legacyFocusId === focusId || item.id === focusId);
    if (byId) return byId;

    const needles = [hotspot.name, hotspot.location]
      .filter((value): value is string => typeof value === 'string' && value.trim().length >= 4)
      .map((value) => value.trim().toLowerCase());
    const byText = items.find((item) => {
      const haystack = `${item.locationName ?? ''} ${item.title}`.toLowerCase();
      return needles.some((needle) => haystack.includes(needle));
    });
    if (byText) return byText;

    return items.find((item) => (
      item.lat !== undefined && item.lon !== undefined
      && Math.abs(item.lat - hotspot.lat) <= 2.5
      && Math.abs(item.lon - hotspot.lon) <= 2.5
    )) ?? null;
  }

  /** Select, reveal, and briefly flash a feed row without changing the inspector. */
  private highlightFeedRow(item: OpsFeedItem): void {
    const rows = this.feedList?.querySelectorAll<HTMLButtonElement>('.ops-feed-item');
    if (!rows) return;
    let target: HTMLButtonElement | null = null;
    rows.forEach((row) => {
      if (row.dataset.focusId === item.id) target = row;
      else row.removeAttribute('aria-current');
    });
    if (!target) return;
    const button: HTMLButtonElement = target;
    button.setAttribute('aria-current', 'true');
    button.scrollIntoView({ block: 'nearest' });
    flashElement(button, 'ops-feed-flash');
  }

  private inspectAlert(alert: BreakingAlert): void {
    this.selection = { kind: 'alert', alert };
    this.setFocus(null);
    const content = this.beginInspector('Breaking alert', alert.headline, `${alert.source} · ${formatTimeAgo(coerceDate(alert.timestamp))}`);
    const badges = el('div', 'ops-inspector-badges');
    badges.appendChild(badge(sentence(alert.threatLevel), `level-${alert.threatLevel}`));
    if (alert.countryCode) badges.appendChild(badge(alert.countryCode, 'location'));
    content.appendChild(badges);
    const copy = el('p', 'ops-inspector-copy');
    copy.textContent = alert.description || 'This is an automated high-priority signal. Verify the report with the linked source and corroborating evidence before acting.';
    content.appendChild(copy);
    content.appendChild(fact('Origin', sentence(alert.origin.replace(/_/g, ' '))));
    if (alert.link) {
      const actions = el('div', 'ops-inspector-actions');
      const link = el('a', 'ops-inspector-action primary') as HTMLAnchorElement;
      link.href = alert.link;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open source ↗';
      actions.appendChild(link);
      content.appendChild(actions);
    }
    this.openInspector();
  }

  /**
   * Country deep-dive in the inspector rail. Map country clicks route here in
   * ops mode (see CountryIntelManager.setupCountryIntel); the classic full-page
   * deep-dive stays one click away via the delegate's openFullBrief.
   */
  inspectCountry(code: string, name: string, intel: OpsCountryIntel): void {
    const iso = code.trim().toUpperCase();
    const selection: InspectorSelection = { kind: 'country', code: iso, name };
    this.selection = selection;
    this.setFocus(null);
    const content = this.beginInspector('Country', `${name} ${toFlagEmoji(iso)}`, iso);

    const signalsHost = el('div', 'ops-country-signals');
    signalsHost.setAttribute('aria-busy', 'true');
    const status = loadingState('Compiling live signals for this country', 3, 'ops-country-status');
    signalsHost.appendChild(status);
    content.appendChild(signalsHost);

    const actions = el('div', 'ops-inspector-actions');
    if (!VANTAGE_PUBLIC_MODE) {
      actions.appendChild(actionButton('Open full deep-dive', () => intel.openFullBrief(), true));
    }
    const watchButton = actionButton('', (button) => {
      toggleCountry(iso);
      syncWatchButton(button, 'country', iso);
    });
    syncWatchButton(watchButton, 'country', iso);
    actions.appendChild(watchButton);
    content.appendChild(actions);
    // Secondary details arrive after the summary. Keeping them below the
    // actions prevents the primary controls from moving under the pointer.
    const detailsHost = el('div', 'ops-country-details');
    content.appendChild(detailsHost);
    this.openInspector();
    this.syncFeedSelection();

    void (async () => {
      let signals: CountryBriefSignals | null = null;
      try {
        signals = await intel.getSignals();
      } catch {
        signals = null;
      }
      if (this.destroyed || this.selection !== selection || !signalsHost.isConnected) return;
      signalsHost.replaceChildren();
      signalsHost.removeAttribute('aria-busy');
      if (!signals) {
        const failed = el('p', 'ops-inspector-copy');
        failed.textContent = VANTAGE_PUBLIC_MODE
          ? 'Country signals are unavailable right now. Current reporting remains available in the intelligence feed.'
          : 'Country signals are unavailable right now. The full deep-dive may still load them.';
        signalsHost.appendChild(failed);
        revealAsyncContent(signalsHost);
        return;
      }
      this.renderCountrySignals(signalsHost, signals);
      revealAsyncContent(signalsHost);

      try {
        const details = await intel.getSignalDetails();
        if (this.destroyed || this.selection !== selection || !detailsHost.isConnected) return;
        this.renderCountrySignalDetails(detailsHost, details);
        revealAsyncContent(detailsHost);
      } catch {
        // Signal-detail chunk unavailable — the summary above stands alone.
      }
    })();
  }

  private renderCountrySignals(host: HTMLElement, signals: CountryBriefSignals): void {
    const badges = el('div', 'ops-inspector-badges');
    if (signals.isTier1) badges.appendChild(badge('Tier 1 coverage', 'sources'));
    if (signals.travelAdvisoryMaxLevel) {
      badges.appendChild(badge(
        `Advisory: ${sentence(signals.travelAdvisoryMaxLevel.replace(/-/g, ' '))}`,
        advisoryBadgeModifier(signals.travelAdvisoryMaxLevel),
      ));
    }
    if (badges.childElementCount > 0) host.appendChild(badges);

    const entries: Array<[string, string]> = [];
    const count = (label: string, value: number): void => {
      if (value > 0) entries.push([label, String(value)]);
    };
    count('Critical news', signals.criticalNews);
    count('Active strikes', signals.activeStrikes);
    count('Conflict events', signals.conflictEvents);
    count('Protests', signals.protests);
    count('Mil flights near', signals.militaryFlights);
    count('Mil vessels near', signals.militaryVessels);
    count('Mil flights inside', signals.militaryFlightsInCountry);
    count('Mil vessels inside', signals.militaryVesselsInCountry);
    count('Net outages', signals.outages);
    count('AIS disruptions', signals.aisDisruptions);
    count('Satellite fires', signals.satelliteFires);
    count('Radiation anomalies', signals.radiationAnomalies);
    count('Temporal anomalies', signals.temporalAnomalies);
    count('Cyber threats', signals.cyberThreats);
    count('Earthquakes', signals.earthquakes);
    count('GPS jamming hexes', signals.gpsJammingHexes);
    count('Thermal escalations', signals.thermalEscalations);
    count('Aviation disruptions', signals.aviationDisruptions);
    count('Travel advisories', signals.travelAdvisories);
    count('Sanctions entries', signals.sanctionsDesignations);
    count('New sanctions', signals.sanctionsNewDesignations);
    count('Oref sirens live', signals.orefSirens);
    count('Oref sirens 24h', signals.orefHistory24h);
    if (signals.displacementOutflow > 0) {
      entries.push(['Displacement out', formatCompactCount(signals.displacementOutflow)]);
    }
    if (signals.climateStress > 0) {
      entries.push(['Climate stress', String(Math.round(signals.climateStress))]);
    }

    if (entries.length === 0) {
      const quiet = el('p', 'ops-inspector-copy');
      quiet.textContent = 'No active signals tracked for this country in the current caches.';
      host.appendChild(quiet);
      return;
    }
    const facts = el('div', 'ops-inspector-facts');
    for (const [label, value] of entries) facts.appendChild(fact(label, value));
    host.appendChild(facts);
  }

  private renderCountrySignalDetails(host: HTMLElement, details: CountryDeepDiveSignalDetails): void {
    const total = details.critical + details.high + details.medium + details.low;
    if (total === 0 && details.recentHigh.length === 0) return;
    const heading = el('h3', 'ops-inspector-section-title');
    heading.textContent = 'Signal severity';
    host.appendChild(heading);

    const facts = el('div', 'ops-inspector-facts');
    facts.append(
      fact('Critical', String(details.critical)),
      fact('High', String(details.high)),
      fact('Medium', String(details.medium)),
      fact('Low', String(details.low)),
    );
    host.appendChild(facts);

    if (details.recentHigh.length > 0) {
      const list = el('div', 'ops-country-recent');
      for (const signal of details.recentHigh) {
        const row = el('div', 'ops-country-recent-row');
        row.appendChild(badge(sentence(signal.severity), `level-${signal.severity}`));
        const text = el('span', 'ops-country-recent-text');
        text.textContent = signal.description;
        const when = el('span', 'ops-country-recent-when');
        when.textContent = formatTimeAgo(coerceDate(signal.timestamp));
        row.append(text, when);
        list.appendChild(row);
      }
      host.appendChild(list);
    }
  }

  // ---- watchlist strip + alerts ----

  private renderWatchlistStrip(): void {
    const row = this.watchlistRow;
    if (!row) return;
    if (this.watchFilter && !isWatched(this.watchFilter.kind, this.watchFilter.value)) {
      this.watchFilter = null;
    }
    const list = getWatchlist();
    const prefs = getAlertPrefs();
    this.watchBell?.setAttribute('aria-pressed', this.watchSettingsOpen ? 'true' : 'false');
    row.replaceChildren();

    const entries: Array<{ kind: 'country' | 'topic'; value: string; label: string }> = [
      ...list.countries.map((code) => ({
        kind: 'country' as const,
        value: code,
        label: `${toFlagEmoji(code)} ${regionName(code)}`,
      })),
      ...list.topics.map((topic) => ({ kind: 'topic' as const, value: topic, label: `#${topic}` })),
    ];
    row.hidden = entries.length === 0 && !this.watchSettingsOpen;
    if (row.hidden) return;

    for (const entry of entries) {
      const active = this.watchFilter?.kind === entry.kind && this.watchFilter.value === entry.value;
      const chip = el('span', 'ops-watch-chip');
      chip.dataset.active = active ? 'true' : 'false';
      const labelButton = el('button', 'ops-watch-chip-label') as HTMLButtonElement;
      labelButton.type = 'button';
      labelButton.textContent = entry.label;
      labelButton.setAttribute('aria-pressed', active ? 'true' : 'false');
      labelButton.title = active ? 'Clear feed filter' : 'Filter the feed to matching reports';
      labelButton.addEventListener('click', () => {
        this.watchFilter = active ? null : { kind: entry.kind, value: entry.value };
        this.renderWatchlistStrip();
        this.renderFeed();
      });
      const remove = el('button', 'ops-watch-remove') as HTMLButtonElement;
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Stop watching ${entry.label}`);
      remove.addEventListener('click', () => {
        if (entry.kind === 'country') toggleCountry(entry.value);
        else toggleTopic(entry.value);
      });
      chip.append(labelButton, remove);
      row.appendChild(chip);
    }

    if (this.watchFilter) {
      const clear = el('button', 'ops-watch-clear') as HTMLButtonElement;
      clear.type = 'button';
      clear.textContent = 'Clear';
      clear.setAttribute('aria-label', 'Clear the watchlist feed filter');
      clear.addEventListener('click', () => {
        this.watchFilter = null;
        this.renderWatchlistStrip();
        this.renderFeed();
      });
      row.appendChild(clear);
    }

    if (this.watchSettingsOpen) row.appendChild(this.buildAlertSettings(prefs));
  }

  private buildAlertSettings(prefs: AlertPrefs): HTMLElement {
    const wrap = el('div', 'ops-watch-settings');
    const supported = typeof Notification !== 'undefined';

    const toggleLabel = el('label', 'ops-watch-setting');
    const checkbox = el('input') as HTMLInputElement;
    checkbox.type = 'checkbox';
    checkbox.checked = prefs.enabled;
    checkbox.disabled = !supported;
    checkbox.addEventListener('change', () => {
      setAlertPrefs({ enabled: checkbox.checked });
      // Permission is only ever requested on an explicit toggle-on.
      if (checkbox.checked && supported && Notification.permission === 'default') {
        void Notification.requestPermission().then(() => this.renderWatchlistStrip());
      }
    });
    toggleLabel.append(checkbox, document.createTextNode(' Browser alerts'));

    const thresholdLabel = el('label', 'ops-watch-setting');
    const threshold = el('input') as HTMLInputElement;
    threshold.type = 'number';
    threshold.min = '0';
    threshold.max = '100';
    threshold.step = '1';
    threshold.value = String(prefs.escalationThreshold);
    threshold.setAttribute('aria-label', 'Escalation alert threshold');
    threshold.addEventListener('change', () => {
      const parsed = Number.parseInt(threshold.value, 10);
      if (Number.isFinite(parsed)) setAlertPrefs({ escalationThreshold: parsed });
    });
    thresholdLabel.append(document.createTextNode('Threshold '), threshold);

    wrap.append(toggleLabel, thresholdLabel);
    const note = el('span', 'ops-watch-note');
    note.textContent = !supported
      ? 'Notifications unsupported in this browser'
      : Notification.permission === 'denied'
        ? 'Notifications blocked by the browser'
        : Notification.permission === 'default'
          ? 'Permission is requested when enabled'
          : '';
    if (note.textContent) wrap.appendChild(note);
    return wrap;
  }

  /**
   * Runs on the 30s HUD cadence. Fires at most one browser notification per
   * five minutes per kind: escalation-threshold upward crossings and new
   * (previously unseen) feed items matching the watchlist. No-ops entirely
   * when the Notification API is missing (e2e/webviews).
   */
  private checkWatchlistAlerts(): void {
    if (typeof Notification === 'undefined') return;
    const prefs = getAlertPrefs();
    const canNotify = prefs.enabled && Notification.permission === 'granted';
    const now = Date.now();

    const scores = getCachedScores();
    const score = scores?.strategicRisk ? Math.round(scores.strategicRisk.score) : null;
    if (score !== null) {
      const previous = this.lastAlertScore;
      this.lastAlertScore = score;
      if (
        canNotify
        && previous !== null
        && previous < prefs.escalationThreshold
        && score >= prefs.escalationThreshold
        && now - this.lastNotifiedAt.escalation >= ALERT_COOLDOWN_MS
      ) {
        fireNotification(
          'Escalation index crossed threshold',
          `Escalation index is ${score} (threshold ${prefs.escalationThreshold}).`,
        );
        this.lastNotifiedAt.escalation = now;
      }
    }

    const fresh: OpsFeedItem[] = [];
    for (const item of this.collectFeedItems(false)) {
      if (this.seenAlertIds.has(item.id)) continue;
      this.seenAlertIds.add(item.id);
      fresh.push(item);
    }
    if (this.seenAlertIds.size > SEEN_ALERT_LIMIT) {
      this.seenAlertIds = new Set([...this.seenAlertIds].slice(-SEEN_ALERT_LIMIT));
    }
    // First pass only seeds the seen-id set so a page load never alert-storms.
    const seeded = this.alertsSeeded;
    this.alertsSeeded = true;
    if (!seeded || !canNotify) return;
    const list = getWatchlist();
    if (list.countries.length === 0 && list.topics.length === 0) return;
    if (now - this.lastNotifiedAt.watchlist < ALERT_COOLDOWN_MS) return;
    const match = fresh.find((item) => matchesWatchlist(item, list));
    if (match) {
      fireNotification('Watchlist match', match.title);
      this.lastNotifiedAt.watchlist = now;
    }
  }

  private async inspectBrief(): Promise<void> {
    const cachedBrief = this.currentBrief();
    if (cachedBrief) {
      this.selection = { kind: 'brief', brief: cachedBrief };
      this.renderBrief(cachedBrief);
      this.openInspector();
      void this.revalidateBrief(cachedBrief.generatedAt);
      return;
    }
    if (this.briefLoading) return;
    this.briefLoading = true;

    const loading = this.beginInspector('Cited brief', 'Compiling the current picture', 'Cached · public');
    const loadingCopy = loadingState('Loading the latest validated brief and its evidence trail', 4);
    loading.appendChild(loadingCopy);
    this.inspector?.setAttribute('aria-busy', 'true');
    const loadingSelection: InspectorSelection = { kind: 'brief', brief: null };
    this.selection = loadingSelection;
    this.openInspector();

    if (this.briefButton) {
      this.briefButton.setAttribute('aria-busy', 'true');
    }
    this.briefPreviewButton?.setAttribute('aria-busy', 'true');
    let brief: VantageSynthesis | null = null;
    try {
      const insights = await fetchServerInsights(5_000, true) ?? getServerInsights();
      brief = insights ? buildVantageSynthesis(insights) : null;
    } catch {
      brief = null;
    } finally {
      this.briefLoading = false;
      if (this.selection === loadingSelection) this.inspector?.removeAttribute('aria-busy');
      if (this.briefButton) {
        this.briefButton.removeAttribute('aria-busy');
      }
      this.briefPreviewButton?.removeAttribute('aria-busy');
    }
    if (this.selection !== loadingSelection) return;
    if (!brief) {
      this.renderBriefUnavailable();
      return;
    }
    this.selection = { kind: 'brief', brief };
    this.renderBrief(brief);
    this.renderFeed();
  }

  private renderBrief(brief: VantageSynthesis): void {
    const briefLabel = brief.generationMode === 'grounded-fallback'
      ? 'Verified headline brief'
      : brief.degraded
        ? 'Cited assessment · limited'
        : 'Cited assessment';
    const content = this.beginInspector(
      briefLabel,
      'Global situation brief',
      brief.freshness,
    );
    const badges = el('div', 'ops-inspector-badges');
    badges.appendChild(badge(corroborationLabel(brief), brief.confidence === 'HIGH' ? 'sources' : 'location'));
    badges.appendChild(badge(`${brief.sources.length} cited reports`, 'sources'));
    content.appendChild(badges);

    const changedHeading = el('h3', 'ops-inspector-section-title');
    changedHeading.textContent = brief.generationMode === 'grounded-fallback'
      ? 'Current cited reports'
      : 'Current assessment';
    const changed = el('p', 'ops-inspector-copy ops-brief-copy');
    this.appendTextWithCitations(changed, brief.whatChanged, brief);
    const whyHeading = el('h3', 'ops-inspector-section-title');
    whyHeading.textContent = 'Evidence status';
    const why = el('p', 'ops-inspector-copy');
    this.appendTextWithCitations(why, brief.whyItMatters, brief);
    content.append(changedHeading, changed, whyHeading, why);

    if (brief.threads.length > 0) {
      const threadHeading = el('h3', 'ops-inspector-section-title');
      threadHeading.textContent = 'Leading threads';
      const threadList = el('ol', 'ops-brief-threads');
      for (const thread of brief.threads) {
        const item = el('li');
        this.appendTextWithCitations(item, thread.text, brief);
        threadList.appendChild(item);
      }
      content.append(threadHeading, threadList);
    }

    content.appendChild(fact('Evidence', brief.confidenceDetail));
    const provenance = el('p', 'ops-brief-provenance');
    provenance.textContent = brief.provenance;
    content.appendChild(provenance);

    if (brief.sources.length > 0) {
      const evidenceTitle = el('h3', 'ops-inspector-section-title');
      evidenceTitle.textContent = 'Numbered evidence';
      const list = el('div', 'ops-source-list');
      for (const source of brief.sources) {
        const link = el('a', 'ops-source-link') as HTMLAnchorElement;
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.dataset.sourceIndex = String(source.index);
        link.textContent = `[${source.index}] ${source.source} — ${source.title}`;
        list.appendChild(link);
      }
      content.append(evidenceTitle, list);
    }

    this.renderBriefHistory(content);
  }

  private renderBriefUnavailable(): void {
    const unavailable = this.beginInspector('Cited brief', 'Brief temporarily unavailable', 'Freshness unavailable');
    const copy = el('p', 'ops-inspector-copy');
    copy.textContent = 'The latest validated snapshot is not ready. Current reporting remains available in the feed while the next analysis snapshot is published.';
    unavailable.appendChild(copy);
    this.renderBriefHistory(unavailable);
  }

  private async revalidateBrief(previousGeneratedAt: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastBriefRevalidatedAt < 60_000) return;
    this.lastBriefRevalidatedAt = now;
    try {
      const insights = await fetchServerInsights(5_000, true);
      if (!insights || this.selection?.kind !== 'brief') return;
      const refreshed = buildVantageSynthesis(insights);
      if (!refreshed || refreshed.generatedAt === previousGeneratedAt) return;
      // Keep the document the user is reading stable. The refreshed snapshot
      // updates the compact preview and offers an explicit in-place handoff,
      // without resetting inspector scroll or replaying entrance motion.
      this.offerBriefRefresh(refreshed);
      this.renderFeed();
    } catch {
      // Keep the already validated cached brief visible when revalidation fails.
    }
  }

  private offerBriefRefresh(refreshed: VantageSynthesis): void {
    const meta = this.inspector?.querySelector<HTMLElement>('.ops-inspector-meta');
    if (!meta || this.selection?.kind !== 'brief') return;
    const update = el('button', 'ops-brief-update') as HTMLButtonElement;
    update.type = 'button';
    update.textContent = 'New brief available';
    update.setAttribute('aria-label', 'Load updated brief');
    update.addEventListener('click', () => {
      if (!update.isConnected || this.selection?.kind !== 'brief') return;
      this.selection = { kind: 'brief', brief: refreshed };
      this.renderBrief(refreshed);
      this.renderFeed();
    });
    meta.replaceWith(update);
  }

  // ---- brief history & diffs ----

  /** Fetch history only when the user opens its disclosure. */
  private renderBriefHistory(content: HTMLElement): void {
    const disclosure = el('details', 'ops-brief-history-disclosure') as HTMLDetailsElement;
    const summary = el('summary', 'ops-brief-history-summary');
    summary.textContent = 'Brief history';
    const box = el('div', 'ops-brief-history');
    disclosure.append(summary, box);
    content.appendChild(disclosure);

    let loaded = false;
    disclosure.addEventListener('toggle', () => {
      if (!disclosure.open || loaded) return;
      loaded = true;
      box.setAttribute('aria-busy', 'true');
      const status = loadingState('Loading archived briefs', 2, 'ops-history-loading');
      box.appendChild(status);
      void fetchBriefHistory().then((history) => {
      if (this.destroyed || this.selection?.kind !== 'brief' || !box.isConnected) return;
      box.removeAttribute('aria-busy');
      box.replaceChildren();
      if (history.entries.length === 0) {
        const empty = el('p', 'ops-history-status');
        empty.textContent = 'Brief history appears as new analysis snapshots are published.';
        box.appendChild(empty);
        revealAsyncContent(box);
        return;
      }
      for (const entry of history.entries.slice(0, BRIEF_HISTORY_LIMIT)) {
        const row = el('button', 'ops-history-entry') as HTMLButtonElement;
        row.type = 'button';
        const when = el('span', 'ops-history-when');
        when.textContent = formatTimeAgo(coerceDate(entry.generatedAt));
        when.title = formatAbsoluteTime(coerceDate(entry.generatedAt));
        const headline = el('span', 'ops-history-headline');
        headline.textContent = entry.headline
          || (entry.clusterCount !== null ? `${entry.clusterCount} clusters` : 'Archived brief');
        row.append(when, headline);
        row.addEventListener('click', () => { void this.inspectArchivedBrief(entry.generatedAt); });
        box.appendChild(row);
      }
      const diffHost = el('div', 'ops-diff');
      box.appendChild(actionButton('What changed vs yesterday', () => this.renderBriefDiff(diffHost)));
      box.appendChild(diffHost);
      revealAsyncContent(box);
      }).catch(() => {
        if (this.destroyed || !box.isConnected) return;
        box.removeAttribute('aria-busy');
        box.replaceChildren();
        const failed = el('p', 'ops-history-status');
        failed.textContent = 'History unavailable';
        box.appendChild(failed);
        revealAsyncContent(box);
      });
    });
  }

  /**
   * Diff of the latest archived brief against the entry closest to 24h before
   * it. Selector order matters: added/kept describe snapshot `b`, so
   * a='yesterday', b='latest' makes `added` the lines new in today's brief.
   */
  private renderBriefDiff(host: HTMLElement): void {
    host.replaceChildren();
    host.setAttribute('aria-busy', 'true');
    const status = loadingState('Comparing against yesterday', 3, 'ops-history-loading');
    host.appendChild(status);

    void fetchBriefDiff('yesterday', 'latest').then((diff) => {
      if (this.destroyed || !host.isConnected) return;
      host.removeAttribute('aria-busy');
      host.replaceChildren();
      const baseline = diff.a.generatedAt
        ? `Baseline ${formatAbsoluteTime(coerceDate(diff.a.generatedAt))}`
        : 'Baseline unavailable';
      const meta = el('p', 'ops-history-status');
      meta.textContent = baseline;
      host.appendChild(meta);

      let lines = 0;
      for (const text of diff.added) {
        host.appendChild(diffLine('added', `+ ${text}`));
        lines++;
      }
      for (const text of diff.removed) {
        host.appendChild(diffLine('removed', `− ${text}`));
        lines++;
      }
      for (const kept of diff.kept) {
        if (!kept.changed) continue;
        const line = diffLine('changed', `~ ${kept.text}`);
        line.title = `Was: ${kept.previousText}`;
        host.appendChild(line);
        lines++;
      }
      if (lines === 0) {
        const same = el('p', 'ops-history-status');
        same.textContent = 'No substantive line changes vs yesterday.';
        host.appendChild(same);
      }
      revealAsyncContent(host);
    }).catch(() => {
      if (this.destroyed || !host.isConnected) return;
      host.removeAttribute('aria-busy');
      host.replaceChildren();
      const failed = el('p', 'ops-history-status');
      failed.textContent = 'History unavailable';
      host.appendChild(failed);
      revealAsyncContent(host);
    });
  }

  private async inspectArchivedBrief(at: string): Promise<void> {
    const selection: InspectorSelection = { kind: 'brief', brief: null };
    this.selection = selection;
    const loading = this.beginInspector(
      'AI synthesis · archive',
      'Loading archived brief',
      formatAbsoluteTime(coerceDate(at)),
    );
    const copy = loadingState('Fetching the archived snapshot', 4);
    loading.appendChild(copy);
    this.inspector?.setAttribute('aria-busy', 'true');
    this.openInspector();

    let snapshot: ArchivedBriefSnapshot;
    try {
      snapshot = await fetchBriefSnapshot(at);
    } catch {
      if (this.destroyed || this.selection !== selection) return;
      this.inspector?.removeAttribute('aria-busy');
      const failed = this.beginInspector('AI synthesis · archive', 'History unavailable', formatAbsoluteTime(coerceDate(at)));
      const note = el('p', 'ops-inspector-copy');
      note.textContent = 'This archived snapshot could not be loaded. The live brief remains available.';
      failed.appendChild(note);
      const actions = el('div', 'ops-inspector-actions');
      actions.appendChild(actionButton('Back to live', () => { void this.inspectBrief(); }, true));
      failed.appendChild(actions);
      return;
    }
    if (this.destroyed || this.selection !== selection) return;
    this.inspector?.removeAttribute('aria-busy');

    const generated = coerceDate(snapshot.generatedAt);
    const content = this.beginInspector(
      'AI synthesis · archive',
      'Global situation brief (archived)',
      `Generated ${formatAbsoluteTime(generated)}`,
    );
    const label = el('p', 'ops-brief-provenance');
    label.textContent = `Archived snapshot from ${formatAbsoluteTime(generated)} — not the live picture.`;
    content.appendChild(label);

    if (snapshot.briefStoryLines && snapshot.briefStoryLines.length > 0) {
      const list = el('ol', 'ops-brief-threads');
      for (const line of snapshot.briefStoryLines) {
        const item = el('li');
        item.textContent = line.text;
        list.appendChild(item);
      }
      content.appendChild(list);
    } else {
      const body = el('p', 'ops-inspector-copy ops-brief-copy');
      body.textContent = snapshot.worldBrief;
      content.appendChild(body);
    }

    const facts = el('div', 'ops-inspector-facts');
    facts.appendChild(fact('Clusters', snapshot.clusterCount !== null ? String(snapshot.clusterCount) : 'n/a'));
    if (snapshot.provenance) {
      facts.appendChild(fact('Stories', String(snapshot.provenance.storiesConsidered)));
      facts.appendChild(fact('Named feeds', String(snapshot.provenance.sourcesConsidered)));
    }
    content.appendChild(facts);

    if (snapshot.worldBriefSources.length > 0) {
      const evidenceTitle = el('h3', 'ops-inspector-section-title');
      evidenceTitle.textContent = 'Numbered evidence';
      const list = el('div', 'ops-source-list');
      for (const source of snapshot.worldBriefSources) {
        const link = el('a', 'ops-source-link') as HTMLAnchorElement;
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = `[${source.index}] ${source.source} — ${source.title}`;
        list.appendChild(link);
      }
      content.append(evidenceTitle, list);
    }

    const actions = el('div', 'ops-inspector-actions');
    actions.appendChild(actionButton('Back to live', () => { void this.inspectBrief(); }, true));
    content.appendChild(actions);
  }

  /**
   * Renders brief prose as text nodes interleaved with [n] citation buttons.
   * Markers with no matching numbered source stay literal text.
   */
  private appendTextWithCitations(target: HTMLElement, text: string, brief: VantageSynthesis): void {
    let cursor = 0;
    for (const match of text.matchAll(CITATION_PATTERN)) {
      const index = Number(match[1]);
      if (!brief.sources.some((source) => source.index === index)) continue;
      const matchIndex = match.index ?? 0;
      if (matchIndex > cursor) target.appendChild(document.createTextNode(text.slice(cursor, matchIndex)));
      const citation = el('button', 'ops-citation') as HTMLButtonElement;
      citation.type = 'button';
      citation.textContent = `[${index}]`;
      citation.setAttribute('aria-label', `Show evidence source ${index}`);
      citation.addEventListener('click', () => this.focusBriefSource(index, brief));
      target.appendChild(citation);
      cursor = matchIndex + match[0].length;
    }
    if (cursor < text.length) target.appendChild(document.createTextNode(text.slice(cursor)));
  }

  /** Citation click: reveal the numbered evidence entry, then the matching feed row if any. */
  private focusBriefSource(index: number, brief: VantageSynthesis): void {
    const entry = this.inspector?.querySelector<HTMLElement>(
      `.ops-source-list [data-source-index="${index}"]`,
    );
    if (entry) {
      entry.scrollIntoView({ block: 'nearest' });
      flashElement(entry, 'ops-source-flash');
    }
    const source = brief.sources.find((candidate) => candidate.index === index);
    if (!source) return;
    const wantedTitle = source.title.trim().toLowerCase();
    const item = this.collectFeedItems(true).find((candidate) => (
      candidate.link === source.url
      || candidate.title.trim().toLowerCase() === wantedTitle
      || candidate.allItems.some((news) => (
        news.link === source.url || news.title.trim().toLowerCase() === wantedTitle
      ))
    ));
    if (item) this.highlightFeedRow(item);
  }

  private inspectEscalation(): void {
    this.selection = { kind: 'signal' };
    this.setFocus(null);
    const scores = getCachedScores();
    const risk = scores && scores.cii.length > 0 ? scores.strategicRisk : null;

    if (!scores || !risk) {
      const content = this.beginInspector('Signal', 'Escalation index', 'Provenance');
      const empty = el('p', 'ops-inspector-copy');
      empty.textContent = 'No cached risk snapshot yet. The breakdown appears once the intelligence backend returns its first scored snapshot.';
      content.appendChild(empty);
      this.openInspector();
      this.syncFeedSelection();
      return;
    }

    const content = this.beginInspector(
      'Signal',
      'Escalation index',
      scores.computedAt ? `Computed ${formatAbsoluteTime(new Date(scores.computedAt))}` : 'Computation time unavailable',
    );

    const displayLevel = getStrategicRiskDisplayLevel(risk.score);
    const badges = el('div', 'ops-inspector-badges');
    badges.appendChild(badge(sentence(displayLevel), `level-${displayLevel}`));
    badges.appendChild(badge(`Trend ${risk.trend}`, 'location'));
    content.appendChild(badges);

    const facts = el('div', 'ops-inspector-facts');
    facts.append(
      fact('Score', `${Math.round(risk.score)} / 100`),
      fact('Level', sentence(displayLevel)),
    );
    content.appendChild(facts);

    if (risk.contributors.length > 0) {
      const heading = el('h3', 'ops-inspector-section-title');
      heading.textContent = 'Contributing signals';
      const list = el('div', 'ops-contrib-list');
      for (const contributor of risk.contributors) {
        const row = el('div', 'ops-contrib-row');
        const name = el('span', 'ops-contrib-name');
        name.textContent = contributor.country;
        const bar = el('div', 'ops-contrib-bar');
        const fill = el('i');
        fill.style.width = `${Math.max(2, Math.min(100, Math.round(contributor.score)))}%`;
        bar.appendChild(fill);
        const value = el('span', 'ops-contrib-value');
        value.textContent = String(Math.round(contributor.score));
        row.append(name, bar, value);
        list.appendChild(row);
      }
      content.append(heading, list);
    }

    const regionHeading = el('h3', 'ops-inspector-section-title');
    regionHeading.textContent = 'Regions';
    content.appendChild(regionHeading);
    const regions = scores.cii
      .filter((entry) => entry.level === 'elevated' || entry.level === 'high' || entry.level === 'critical')
      .sort((a, b) => b.score - a.score);
    if (regions.length === 0) {
      const none = el('p', 'ops-inspector-copy');
      none.textContent = 'No countries are currently at elevated instability or above.';
      content.appendChild(none);
    } else {
      const list = el('div', 'ops-region-list');
      for (const region of regions) {
        const row = el('div', 'ops-region-row');
        const name = el('span', 'ops-region-name');
        name.textContent = region.name;
        const level = el('span', 'ops-region-level');
        level.dataset.level = region.level;
        level.textContent = sentence(region.level);
        const value = el('span', 'ops-contrib-value');
        value.textContent = String(Math.round(region.score));
        row.append(name, level, value);
        list.appendChild(row);
      }
      content.appendChild(list);
    }

    const trendHeading = el('h3', 'ops-inspector-section-title');
    trendHeading.textContent = 'Trend';
    content.appendChild(trendHeading);
    const history = this.loadEscalationHistory();
    if (history.length >= 2) content.appendChild(buildSparkline(history));
    const delta = el('p', 'ops-trend-delta');
    const deltaLabel = el('span');
    deltaLabel.textContent = 'Δ vs 24h ago: ';
    const deltaValue = el('b');
    const change = escalationDelta24h(history);
    deltaValue.textContent = change === null ? 'n/a' : `${change > 0 ? '+' : ''}${change}`;
    delta.append(deltaLabel, deltaValue);
    content.appendChild(delta);
    if (history.length < 2) {
      const note = el('p', 'ops-inspector-copy');
      note.textContent = 'Trend history accumulates in this browser as new snapshots arrive.';
      content.appendChild(note);
    }

    this.openInspector();
    this.syncFeedSelection();
  }

  private loadEscalationHistory(): EscalationSample[] {
    if (this.escalationHistory) return this.escalationHistory;
    let samples: EscalationSample[] = [];
    try {
      const raw = localStorage.getItem(ESCALATION_HISTORY_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) {
        samples = parsed
          .filter((entry): entry is EscalationSample => (
            typeof entry === 'object' && entry !== null
            && Number.isFinite((entry as EscalationSample).t)
            && Number.isFinite((entry as EscalationSample).score)
          ))
          .map((entry) => ({ t: entry.t, score: entry.score }));
      }
    } catch { /* corrupt or unavailable storage — start fresh */ }
    samples.sort((a, b) => a.t - b.t);
    this.escalationHistory = samples.slice(-ESCALATION_HISTORY_LIMIT);
    return this.escalationHistory;
  }

  private recordEscalationHistory(score: number): void {
    const history = this.loadEscalationHistory();
    const now = Date.now();
    const bucket = Math.floor(now / ESCALATION_BUCKET_MS);
    const last = history[history.length - 1];
    if (last && Math.floor(last.t / ESCALATION_BUCKET_MS) === bucket) {
      last.t = now;
      last.score = score;
    } else {
      history.push({ t: now, score });
      if (history.length > ESCALATION_HISTORY_LIMIT) {
        history.splice(0, history.length - ESCALATION_HISTORY_LIMIT);
      }
    }
    try {
      localStorage.setItem(ESCALATION_HISTORY_KEY, JSON.stringify(history));
    } catch { /* quota exceeded — in-memory history still serves this session */ }
  }

  private beginInspector(kicker: string, titleText: string, metaText?: string): HTMLElement {
    if (!this.inspector) return el('div');
    this.inspector.removeAttribute('aria-busy');
    const hadFocus = document.activeElement instanceof HTMLElement
      && this.inspector.contains(document.activeElement);
    const header = el('div', 'ops-inspector-head');
    const labels = el('div');
    const kickerEl = el('div', 'ops-inspector-kicker');
    kickerEl.textContent = kicker;
    if (metaText) {
      const meta = el('div', 'ops-inspector-meta');
      meta.textContent = metaText;
      labels.append(kickerEl, meta);
    } else {
      labels.appendChild(kickerEl);
    }
    const close = iconButton('×', 'Close inspector', () => this.closeInspector());
    header.append(labels, close);
    const title = el('h2', 'ops-inspector-title');
    title.id = 'opsInspectorTitle';
    title.textContent = titleText;
    const content = el('div', 'ops-inspector-content');
    content.appendChild(title);
    this.inspector.replaceChildren(header, content);
    this.inspector.setAttribute('aria-labelledby', title.id);
    if (hadFocus) requestAnimationFrame(() => close.focus());
    return content;
  }

  private openInspector(): void {
    if (!this.inspector || !this.body) return;
    const wasHidden = this.inspector.hidden;
    if (wasHidden) {
      this.inspectorReturnFocus = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    }
    this.inspector.hidden = false;
    this.body.classList.add('has-inspector');
    requestAnimationFrame(() => {
      if (wasHidden) this.inspector?.querySelector<HTMLButtonElement>('.ops-inspector-head button')?.focus();
    });
    this.resizeMapForShellTransition();
  }

  private closeInspector(): void {
    if (!this.inspector || !this.body) return;
    this.selection = null;
    this.inspector.removeAttribute('aria-busy');
    this.inspector.hidden = true;
    this.body.classList.remove('has-inspector');
    this.setFocus(null);
    this.syncFeedSelection();
    const restore = this.inspectorReturnFocus;
    this.inspectorReturnFocus = null;
    requestAnimationFrame(() => {
      if (restore?.isConnected) restore.focus();
    });
    this.resizeMapForShellTransition();
  }

  private resizeMapForShellTransition(): void {
    requestAnimationFrame(() => this.ctx.map?.resize?.());
  }

  private syncFeedSelection(): void {
    const selected = this.selection?.kind === 'feed' ? this.selection.item.id : null;
    this.feedList?.querySelectorAll<HTMLButtonElement>('.ops-feed-item').forEach((button) => {
      if (button.dataset.focusId === selected) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
  }

  private setFocus(focus: string | null): void {
    this.ctx.opsFocus = focus;
    try {
      const url = new URL(window.location.href);
      if (focus) url.searchParams.set(FOCUS_PARAM, focus);
      else url.searchParams.delete(FOCUS_PARAM);
      window.history.replaceState(window.history.state, '', url);
    } catch {
      // Opaque WebView origins can reject URL/history mutation; map URL sync
      // still carries ctx.opsFocus on the next successful state update.
    }
  }

  private restoreDeepLinkedFocus(): void {
    if (this.selection || !this.ctx.opsFocus) return;
    const focus = this.ctx.opsFocus;
    if (!focus.startsWith('hotspot:')) return;
    if (this.focusRestoreTimers.length > 0) return;
    const id = focus.slice('hotspot:'.length);
    for (const delay of [250, 900, 1_800]) {
      const timer = window.setTimeout(() => {
        this.focusRestoreTimers = this.focusRestoreTimers.filter((candidate) => candidate !== timer);
        if (!this.selection && this.ctx.opsFocus === focus) this.ctx.map?.triggerHotspotClick(id);
      }, delay);
      this.focusRestoreTimers.push(timer);
    }
  }

  private async copyCurrentUrl(button: HTMLButtonElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(window.location.href);
      button.textContent = 'Copied';
      window.setTimeout(() => { if (button.isConnected) button.textContent = 'Copy deep link'; }, 1_500);
    } catch {
      button.textContent = 'Copy failed';
    }
  }

  // ---- status + HUD ----

  private syncTimeChips(active: TimeRange): void {
    for (const [range, buttons] of this.timeButtons) {
      for (const button of [...buttons]) {
        if (!button.isConnected) {
          buttons.delete(button);
          continue;
        }
        button.setAttribute('aria-pressed', range === active ? 'true' : 'false');
      }
    }
    this.updateStatusLine();
  }

  private updateStatusLine(): void {
    if (!this.statusLine) return;
    const range = (this.ctx.map?.getTimeRange() ?? this.ctx.currentTimeRange).toUpperCase();
    if (VANTAGE_PUBLIC_MODE && !VANTAGE_RELAY_ENABLED) {
      this.statusLine.textContent = `Window ${range} · Coverage limited`;
      return;
    }
    const ais = safeAisStatus();
    const maritime = ais.availability === 'live'
      ? 'AIS live'
      : ais.availability === 'traffic'
        ? 'Maritime traffic'
        : ais.availability === 'unavailable'
          ? 'Maritime unavailable'
          : 'Maritime checking';
    this.statusLine.textContent = `Window ${range} · ${maritime}`;
  }

  private updateHud(): void {
    const scores = getCachedScores();
    const risk = scores?.strategicRisk ?? null;
    if (this.hudScore) this.hudScore.textContent = risk ? String(Math.round(risk.score)) : '--';
    if (this.hudLevel) {
      const level = risk ? getStrategicRiskDisplayLevel(risk.score) : 'low';
      this.hudLevel.textContent = risk ? sentence(level) : 'Pending';
      this.hudLevel.dataset.level = level;
    }
    if (risk && scores && scores.cii.length > 0) {
      this.recordEscalationHistory(Math.round(risk.score));
    }

    const militaryFlights = this.ctx.intelligenceCache.military?.flights?.length ?? 0;
    const ais = safeAisStatus();
    const events = this.ctx.latestClusters.length || this.ctx.allNews.length;

    if (this.countAir) {
      this.countAir.hidden = VANTAGE_PUBLIC_MODE && !VANTAGE_RELAY_ENABLED;
      if (!this.countAir.hidden) setCount(this.countAir, militaryFlights, 'air');
    }
    if (this.countShips) {
      this.countShips.hidden = VANTAGE_PUBLIC_MODE && !VANTAGE_RELAY_ENABLED;
      if (!this.countShips.hidden) {
        if (ais.availability === 'traffic') setCount(this.countShips, ais.zones, 'maritime zones');
        else if (ais.availability === 'unavailable') this.countShips.textContent = 'ships unavailable';
        else setCount(this.countShips, ais.vessels, 'ships');
      }
    }
    if (this.countEvents) setCount(this.countEvents, events, 'events');
    this.updateStatusLine();
    this.checkWatchlistAlerts();
  }

  private toggleShortcuts(open: boolean): void {
    if (!this.shortcutsOverlay) return;
    if (open) {
      this.shortcutsReturnFocus = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    }
    for (const child of [...(this.root?.children ?? [])]) {
      if (child instanceof HTMLElement && child !== this.shortcutsOverlay) child.inert = open;
    }
    this.shortcutsOverlay.hidden = !open;
    if (open) {
      this.shortcutsOverlay.querySelector<HTMLButtonElement>('button')?.focus();
    } else {
      const restore = this.shortcutsReturnFocus;
      this.shortcutsReturnFocus = null;
      if (restore?.isConnected) requestAnimationFrame(() => restore.focus());
    }
  }
}

// ---- small DOM/data helpers ----

function loadingState(label: string, lineCount = 3, modifier = ''): HTMLElement {
  const node = el('div', `ops-loading-state${modifier ? ` ${modifier}` : ''}`);
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  node.setAttribute('aria-atomic', 'true');
  const text = el('span', 'ops-loading-label');
  text.textContent = `${label}…`;
  const lines = el('span', 'ops-loading-lines');
  lines.setAttribute('aria-hidden', 'true');
  const widths = ['92%', '74%', '84%', '61%', '78%'];
  for (let index = 0; index < lineCount; index++) {
    const line = el('i', 'ops-loading-line');
    line.style.setProperty('--loading-width', widths[index % widths.length] ?? '80%');
    lines.appendChild(line);
  }
  node.append(text, lines);
  return node;
}

function feedLoadingState(): HTMLElement {
  const node = el('div', 'ops-loading-state ops-feed-loading');
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  node.setAttribute('aria-atomic', 'true');
  const text = el('span', 'ops-loading-label');
  text.textContent = 'Loading current reporting…';
  const rows = el('span', 'ops-feed-loading-rows');
  rows.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 5; index++) {
    const row = el('span', 'ops-feed-loading-row');
    row.append(el('i'), el('b'), el('span'));
    rows.appendChild(row);
  }
  node.append(text, rows);
  return node;
}

function revealAsyncContent(host: HTMLElement): void {
  host.classList.remove('ops-content-enter');
  // Restart the short resolution transition when a second async stage (for
  // example country details after its summary) lands in the same container.
  void host.offsetWidth;
  host.classList.add('ops-content-enter');
}

function stripCitations(text: string): string {
  return text.replace(CITATION_PATTERN, '').replace(/\s+/g, ' ').trim();
}

function corroborationLabel(brief: VantageSynthesis): string {
  const match = brief.confidenceDetail.match(/^(\d+) of (\d+)/);
  return match ? `${match[1]}/${match[2]} multi-outlet` : `${sentence(brief.confidence)} evidence`;
}

function normalizedTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isBriefLead(item: OpsFeedItem, brief: VantageSynthesis | null): boolean {
  if (!brief) return false;
  const itemTitle = normalizedTitle(item.title);
  return brief.sources.some((source) => {
    const sourceTitle = normalizedTitle(source.title);
    return item.link === source.url
      || itemTitle === sourceTitle
      || item.allItems.some((news) => news.link === source.url || normalizedTitle(news.title) === sourceTitle);
  });
}

function priorityScore(item: OpsFeedItem, brief: VantageSynthesis | null, watchlist: Watchlist): number {
  const threatWeight: Partial<Record<ThreatClassification['level'], number>> = {
    critical: 180,
    high: 130,
    medium: 70,
    low: 20,
    info: 0,
  };
  const importance = Math.max(0, ...item.allItems.map((news) => news.importanceScore ?? 0));
  const ageHours = Math.max(0, (Date.now() - item.when.getTime()) / 3_600_000);
  const freshness = Math.max(0, 72 - ageHours * 3);
  return (isBriefLead(item, brief) ? 600 : 0)
    + (matchesWatchlist(item, watchlist) ? 140 : 0)
    + (item.alert ? 220 : 0)
    + (item.threat ? threatWeight[item.threat.level] ?? 0 : 0)
    + Math.min(100, importance)
    + Math.min(10, Math.max(1, item.sourceCount)) * 12
    + freshness;
}

function priorityReasons(item: OpsFeedItem, brief: VantageSynthesis | null, watchlist: Watchlist): string[] {
  const reasons: string[] = [];
  if (isBriefLead(item, brief)) reasons.push('current brief lead');
  if (matchesWatchlist(item, watchlist)) reasons.push('watchlist match');
  if (item.alert) reasons.push('active alert');
  if (item.threat && (item.threat.level === 'critical' || item.threat.level === 'high')) {
    reasons.push(`${item.threat.level} severity`);
  }
  if (item.sourceCount > 1) reasons.push(`${item.sourceCount}-outlet reporting`);
  if (reasons.length === 0) reasons.push('report freshness');
  return reasons;
}

function cssEscape(value: string): string {
  return CSS.escape(value);
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function trapFocus(event: KeyboardEvent, container: HTMLElement): void {
  const focusable = [...container.querySelectorAll<HTMLElement>(
    'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  )].filter((node) => !node.hidden && node.getAttribute('aria-hidden') !== 'true');
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function sentence(text: string): string {
  const lower = text.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function iconButton(text: string, label: string, handler: () => void): HTMLButtonElement {
  const button = el('button', 'ops-icon-btn') as HTMLButtonElement;
  button.type = 'button';
  button.textContent = text;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', handler);
  return button;
}

function actionButton(
  text: string,
  handler: (button: HTMLButtonElement) => void | Promise<void>,
  primary = false,
): HTMLButtonElement {
  const button = el('button', `ops-inspector-action${primary ? ' primary' : ''}`) as HTMLButtonElement;
  button.type = 'button';
  button.textContent = text;
  button.addEventListener('click', () => { void handler(button); });
  return button;
}

function badge(text: string, modifier: string): HTMLElement {
  const node = el('span', `ops-inspector-badge ${modifier}`);
  node.textContent = text;
  return node;
}

function fact(label: string, value: string): HTMLElement {
  const wrap = el('div', 'ops-inspector-fact');
  const labelEl = el('span');
  labelEl.textContent = label;
  const valueEl = el('b');
  valueEl.textContent = value;
  wrap.append(labelEl, valueEl);
  return wrap;
}

function setCount(node: HTMLElement, value: number | string, label: string): void {
  node.replaceChildren();
  const number = el('b');
  number.textContent = String(value);
  node.append(number, document.createTextNode(` ${label}`));
}

function coerceDate(value: Date | string | number): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date(0);
}

function formatTimeAgo(when: Date): string {
  const minutes = Math.max(0, Math.floor((Date.now() - when.getTime()) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatAbsoluteTime(when: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    hour12: false,
  }).format(when) + ' UTC';
}

function formatTimelineDate(when: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    hour12: false,
  }).format(when);
}

function feedItemFromNews(item: NewsItem): OpsFeedItem {
  return {
    id: `news:${stableHash(item.link || item.title)}`,
    title: item.title,
    source: item.source,
    link: item.link,
    when: coerceDate(item.pubDate),
    alert: item.isAlert,
    sourceCount: Math.max(item.storyMeta?.sourceCount ?? item.corroborationCount ?? 1, 1),
    topSources: [{ name: item.source, url: item.link }],
    allItems: [item],
    ...(item.lat !== undefined && { lat: item.lat }),
    ...(item.lon !== undefined && { lon: item.lon }),
    ...(item.locationName && { locationName: item.locationName }),
    ...(item.snippet && { snippet: item.snippet }),
    ...(item.threat && { threat: item.threat }),
  };
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function uniqueSources(item: OpsFeedItem): Array<{ name: string; url: string }> {
  const sources = item.topSources.length > 0
    ? item.topSources
    : item.allItems.map((entry) => ({ name: entry.source, url: entry.link }));
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.name}|${source.url}`;
    if (!source.url || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeAisStatus(): {
  connected: boolean;
  vessels: number;
  availability: 'unknown' | 'live' | 'traffic' | 'unavailable';
  zones: number;
} {
  try {
    return getAisStatus();
  } catch {
    return { connected: false, vessels: 0, availability: 'unavailable', zones: 0 };
  }
}

/** Restartable one-shot flash: CSS animates the class, JS only adds/removes it. */
function flashElement(node: HTMLElement, className: string): void {
  node.classList.remove(className);
  requestAnimationFrame(() => node.classList.add(className));
  window.setTimeout(() => {
    if (node.isConnected) node.classList.remove(className);
  }, FLASH_MS);
}

/** Score change vs ~24h ago; null until a sample exists within ±3h of that mark. */
function escalationDelta24h(history: EscalationSample[]): number | null {
  const latest = history[history.length - 1];
  if (!latest) return null;
  const target = Date.now() - 24 * 60 * 60_000;
  let baseline: EscalationSample | null = null;
  for (const sample of history) {
    if (baseline === null || Math.abs(sample.t - target) < Math.abs(baseline.t - target)) {
      baseline = sample;
    }
  }
  if (!baseline || Math.abs(baseline.t - target) > 3 * 60 * 60_000) return null;
  return Math.round(latest.score - baseline.score);
}

function buildSparkline(history: EscalationSample[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ops-spark');
  svg.setAttribute('viewBox', '0 0 240 40');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Escalation index history over the recorded window');
  const first = history[0];
  const last = history[history.length - 1];
  if (!first || !last) return svg;
  const timeSpan = Math.max(1, last.t - first.t);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const sample of history) {
    min = Math.min(min, sample.score);
    max = Math.max(max, sample.score);
  }
  const scoreSpan = Math.max(1, max - min);
  const points = history
    .map((sample) => {
      const x = ((sample.t - first.t) / timeSpan) * 240;
      const y = 36 - ((sample.score - min) / scoreSpan) * 32;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', points);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  line.style.stroke = 'var(--ops-accent)';
  svg.appendChild(line);
  return svg;
}

function isEditableTarget(target: HTMLElement | null): boolean {
  if (!target) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

// ---- watchlist helpers ----

type RegionDisplayNamesCtor = new (
  locales: string[],
  options: { type: 'region' },
) => { of(code: string): string | undefined };

/** ISO2 → English region name via Intl.DisplayNames; falls back to the code. */
function regionName(code: string): string {
  const iso = code.trim().toUpperCase();
  try {
    const ctor = (Intl as unknown as { DisplayNames?: RegionDisplayNamesCtor }).DisplayNames;
    const resolved = ctor ? new ctor(['en'], { type: 'region' }).of(iso) : undefined;
    if (resolved && resolved.toUpperCase() !== iso) return resolved;
  } catch {
    // Intl.DisplayNames unavailable — the bare code still identifies the chip.
  }
  return iso;
}

const TOPIC_STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'ahead', 'amid', 'among', 'been', 'before',
  'being', 'between', 'breaking', 'could', 'down', 'during', 'first', 'former',
  'from', 'have', 'here', 'into', 'just', 'latest', 'live', 'more', 'near', 'news',
  'over', 'report', 'reported', 'reportedly', 'reports', 'said', 'says', 'should',
  'some', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'those', 'today', 'under', 'update', 'updates', 'were', 'what', 'when',
  'where', 'which', 'while', 'will', 'with', 'would', 'year', 'years',
]);

/**
 * Dumb, predictable topic derivation for the "Watch topic" action: prefer the
 * item's resolved location name, otherwise the first title token of 4+ chars
 * that is not a stopword.
 */
function deriveWatchTopic(item: OpsFeedItem): string | null {
  const location = item.locationName?.trim().toLowerCase();
  if (location) return location;
  const token = item.title
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .find((word) => word.length >= 4 && !TOPIC_STOPWORDS.has(word));
  return token ?? null;
}

function syncWatchButton(button: HTMLButtonElement, kind: 'country' | 'topic', value: string): void {
  const watched = isWatched(kind, value);
  if (kind === 'country') {
    button.textContent = watched ? 'Unwatch country' : 'Watch country';
  } else {
    button.textContent = watched ? `Unwatch "${value}"` : `Watch "${value}"`;
  }
  button.setAttribute('aria-pressed', watched ? 'true' : 'false');
}

/** Text match against a feed item: country by resolved name, topic verbatim. */
function watchEntryMatches(item: OpsFeedItem, kind: 'country' | 'topic', value: string): boolean {
  const haystack = `${item.locationName ?? ''} ${item.title}`.toLowerCase();
  if (kind === 'topic') return haystack.includes(value.toLowerCase());
  const name = regionName(value).toLowerCase();
  return name.length > 0 && haystack.includes(name);
}

function matchesWatchlist(item: OpsFeedItem, list: Watchlist): boolean {
  return list.countries.some((code) => watchEntryMatches(item, 'country', code))
    || list.topics.some((topic) => watchEntryMatches(item, 'topic', topic));
}

/** Title-only browser notification; never throws (platforms without page-scope Notification). */
function fireNotification(title: string, body: string): void {
  try {
    new Notification(title, { body });
  } catch {
    // Some platforms (e.g. Android Chrome) require a service-worker registration.
  }
}

function advisoryBadgeModifier(level: string): string {
  if (level === 'do-not-travel') return 'level-critical';
  if (level === 'reconsider') return 'level-high';
  if (level === 'caution') return 'level-medium';
  return 'location';
}

function formatCompactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function diffLine(kind: 'added' | 'removed' | 'changed', text: string): HTMLElement {
  const line = el('div', 'ops-diff-line');
  line.dataset.kind = kind;
  line.textContent = text;
  return line;
}
