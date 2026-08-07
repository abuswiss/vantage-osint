/**
 * OpsShell — map-first common operating picture.
 *
 * The classic panel grid remains mounted in an off-screen dock so its existing
 * data loaders keep running. The shell adopts the live map/header controls and
 * turns the same stores into an operator feed, activity timeline, and inspector.
 * `?classic=1` remains the desktop opt-out.
 */
import type { AppContext } from '@/app/app-context';
import type {
  ClusteredEvent,
  Hotspot,
  MapLayers,
  NewsItem,
  ThreatClassification,
} from '@/types';
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

export interface OpsShellHooks {
  onToggleLayer: (layer: keyof MapLayers, enabled: boolean) => void;
  onOpenSearch: () => void;
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
  | { kind: 'brief'; brief: VantageSynthesis | null };

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
const TIMELINE_BUCKETS = 32;
const HUD_REFRESH_MS = 30_000;
const FOCUS_PARAM = 'focus';

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
  private shortcutsOverlay: HTMLElement | null = null;
  private chipButtons = new Map<keyof MapLayers, Set<HTMLButtonElement>>();
  private timeButtons = new Map<TimeRange, HTMLButtonElement>();
  private selection: InspectorSelection | null = null;
  private hudScore: HTMLElement | null = null;
  private hudLevel: HTMLElement | null = null;
  private hudBar: HTMLElement | null = null;
  private hudStats: HTMLElement | null = null;
  private countAir: HTMLElement | null = null;
  private countShips: HTMLElement | null = null;
  private countEvents: HTMLElement | null = null;
  private statusLine: HTMLElement | null = null;
  private hudTimer: ReturnType<typeof setInterval> | null = null;
  private focusRestoreTimers: number[] = [];
  private unsubscribeAuth: (() => void) | null = null;
  private boundKeydown: ((event: KeyboardEvent) => void) | null = null;
  private boundOutsidePointer: ((event: PointerEvent) => void) | null = null;
  private boundOpsAlert: ((event: Event) => void) | null = null;
  private destroyed = false;

  constructor(ctx: AppContext, hooks: OpsShellHooks) {
    this.ctx = ctx;
    this.hooks = hooks;
  }

  mount(): void {
    if (this.root) return;
    document.body.classList.add('ops-mode');

    const shell = el('div', 'ops-shell');
    shell.append(
      this.buildTopBar(),
      this.buildFilterRail(),
      this.buildBody(),
      this.buildBottomBar(),
      this.buildShortcutsOverlay(),
    );
    document.body.appendChild(shell);
    this.root = shell;

    this.dockLegacyPanels();
    this.adoptMap();
    this.adoptHeaderControls();
    this.installInteractionHandlers();

    this.ctx.map?.onHotspotClicked((hotspot) => this.inspectHotspot(hotspot));
    if (!VANTAGE_PUBLIC_MODE) {
      this.unsubscribeAuth = subscribeAuthState(() => this.syncLayerChips());
    }

    this.syncLayerChips();
    this.syncTimeChips(this.ctx.currentTimeRange);
    this.renderFeed();
    this.updateHud();
    this.restoreDeepLinkedFocus();
    this.hudTimer = setInterval(() => this.updateHud(), HUD_REFRESH_MS);

    requestAnimationFrame(() => this.ctx.map?.resize?.());
  }

  destroy(): void {
    this.destroyed = true;
    if (this.hudTimer) clearInterval(this.hudTimer);
    for (const timer of this.focusRestoreTimers) window.clearTimeout(timer);
    this.focusRestoreTimers = [];
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = null;
    if (this.boundKeydown) document.removeEventListener('keydown', this.boundKeydown);
    if (this.boundOutsidePointer) document.removeEventListener('pointerdown', this.boundOutsidePointer);
    if (this.boundOpsAlert) document.removeEventListener('wm:ops-inspect-alert', this.boundOpsAlert);
    this.panelDock?.remove();
    this.panelDock = null;
    this.root?.remove();
    this.root = null;
    document.body.classList.remove('ops-mode');
  }

  /** Called whenever the news/cluster stores change. */
  onDataUpdated(): void {
    if (this.destroyed) return;
    this.renderFeed();
    this.updateHud();
    this.restoreDeepLinkedFocus();
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
        button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        button.disabled = !this.canToggleLayer(key);
        const state = button.querySelector<HTMLElement>('.ops-layer-state');
        if (state) state.textContent = enabled
          ? 'ON'
          : !VANTAGE_PUBLIC_MODE && state.dataset.locked === 'true'
            ? 'PRO'
            : '';
      }
    }

    if (this.moreLayersButton) {
      const active = this.getAvailableLayerDefinitions().filter((definition) => this.ctx.mapLayers[definition.key]).length;
      this.moreLayersButton.textContent = active > 0 ? `Layers ${active}` : 'Layers';
    }
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
    const live = el('span', 'ops-live');
    live.textContent = 'Live';
    brand.appendChild(live);

    const chips = el('div', 'ops-chips');
    for (const definition of PRIMARY_LAYER_CHIPS) {
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

    const right = el('div', 'ops-top-right');
    this.briefButton = el('button', 'ops-brief-button') as HTMLButtonElement;
    this.briefButton.type = 'button';
    this.briefButton.textContent = 'Brief';
    this.briefButton.setAttribute('aria-label', 'Open cited AI situation brief');
    this.briefButton.addEventListener('click', () => { void this.inspectBrief(); });
    const counts = el('div', 'ops-counts');
    this.countAir = el('span');
    this.countShips = el('span');
    this.countEvents = el('span');
    counts.append(this.countAir, this.countShips, this.countEvents);
    if (VANTAGE_PUBLIC_MODE) right.appendChild(this.briefButton);
    right.appendChild(counts);
    right.id = 'opsTopRight';

    top.append(brand, chips, this.moreLayersButton, right, this.layerPopover);
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

  private buildFilterRail(): HTMLElement {
    const rail = el('div', 'ops-filter');
    const label = el('span', 'ops-filter-label');
    label.textContent = 'Time';

    const timeSeg = el('div', 'ops-seg');
    for (const range of TIME_RANGES) {
      const button = el('button', 'ops-seg-btn') as HTMLButtonElement;
      button.type = 'button';
      button.textContent = range === 'all' ? 'All' : range.toUpperCase();
      button.setAttribute('aria-label', `Show ${range === 'all' ? 'all available' : `the last ${range}`} activity`);
      button.addEventListener('click', () => this.ctx.map?.setTimeRange(range));
      timeSeg.appendChild(button);
      this.timeButtons.set(range, button);
    }

    const spacer = el('div', 'ops-filter-spacer');
    const hint = el('span', 'ops-filter-hint');
    hint.textContent = 'J/K navigate · / search · ? shortcuts';
    rail.append(label, timeSeg, spacer, hint);
    return rail;
  }

  private buildBody(): HTMLElement {
    const body = el('div', 'ops-body');
    this.body = body;

    const feed = el('aside', 'ops-feed');
    feed.setAttribute('aria-label', 'Live intelligence feed');
    const head = el('div', 'ops-feed-head');
    const label = el('span');
    label.textContent = 'Live feed';
    this.feedCount = el('span', 'count');
    head.append(label, this.feedCount);
    this.feedList = el('div', 'ops-feed-list');
    feed.append(head, this.feedList);

    const mapArea = el('main', 'ops-map');
    mapArea.id = 'opsMapArea';
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
    const hud = el('div', 'ops-hud');
    const label = el('div', 'ops-hud-label');
    label.textContent = 'Escalation index';

    const score = el('div', 'ops-hud-score');
    this.hudScore = el('b');
    this.hudScore.textContent = '--';
    this.hudLevel = el('span', 'ops-hud-level');
    this.hudLevel.textContent = 'Pending';
    score.append(this.hudScore, this.hudLevel);

    const bar = el('div', 'ops-hud-bar');
    this.hudBar = el('i');
    bar.appendChild(this.hudBar);
    this.hudStats = el('div', 'ops-hud-stats');
    hud.append(label, score, bar, this.hudStats);
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

  private dockLegacyPanels(): void {
    const dock = el('div', 'ops-panel-dock');
    dock.setAttribute('aria-hidden', 'true');
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
    if (VANTAGE_PUBLIC_MODE && !VANTAGE_RELAY_ENABLED && (key === 'military' || key === 'ais')) {
      return false;
    }
    return isLayerCommandAllowed(
      key,
      this.ctx.mapLayers[key],
      this.currentRenderer(),
      this.ctx.map?.isDeckGLActive?.() ?? false,
      !VANTAGE_PUBLIC_MODE && hasPremiumAccess(getAuthState()),
    );
  }

  private toggleLayer(key: keyof MapLayers): void {
    if (!this.canToggleLayer(key)) return;
    this.hooks.onToggleLayer(key, !this.ctx.mapLayers[key]);
    this.syncLayerChips();
  }

  private toggleLayerPopover(force?: boolean): void {
    if (!this.layerPopover || !this.moreLayersButton) return;
    const open = force ?? this.layerPopover.hidden;
    if (open) this.renderLayerPopover();
    this.layerPopover.hidden = !open;
    this.moreLayersButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) this.layerPopover.querySelector<HTMLButtonElement>('.ops-layer-option')?.focus();
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
    this.layerPopover.replaceChildren(header, grid);
    this.syncLayerChips();
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

    const sorted = items.sort((a, b) => b.when.getTime() - a.when.getTime());
    if (!applyWindow) return sorted;
    const range = this.ctx.map?.getTimeRange() ?? this.ctx.currentTimeRange;
    const duration = TIME_RANGE_MS[range];
    const filtered = duration === undefined
      ? sorted
      : sorted.filter((item) => item.when.getTime() >= Date.now() - duration);
    return filtered.slice(0, FEED_LIMIT);
  }

  private renderFeed(): void {
    if (!this.feedList) return;
    const items = this.collectFeedItems(true);
    this.feedList.replaceChildren();
    if (this.feedCount) this.feedCount.textContent = String(items.length);

    if (items.length === 0) {
      const empty = el('div', 'ops-feed-empty');
      empty.textContent = 'Waiting for reporting in this time window…';
      this.feedList.appendChild(empty);
      this.renderTimeline(items);
      return;
    }

    const selectedId = this.selection?.kind === 'feed' ? this.selection.item.id : null;
    for (const item of items) {
      const button = el('button', 'ops-feed-item') as HTMLButtonElement;
      button.type = 'button';
      button.dataset.focusId = item.id;
      if (item.id === selectedId) button.setAttribute('aria-current', 'true');
      const meta = el('div', 'meta');
      const source = el('span', 'src');
      source.textContent = item.source;
      const when = el('span');
      when.textContent = formatTimeAgo(item.when);
      const corroboration = el('span', 'corroboration');
      corroboration.textContent = item.sourceCount > 1 ? `${item.sourceCount} sources` : '';
      meta.append(source, when, corroboration);
      const title = el('div', 'title');
      title.textContent = item.title;
      button.append(meta, title);
      button.addEventListener('click', () => this.inspectFeedItem(item));
      this.feedList.appendChild(button);
    }

    this.renderTimeline(items);
    const focus = this.ctx.opsFocus;
    if (!this.selection && focus) {
      const selected = items.find((item) => item.id === focus || item.legacyFocusId === focus);
      if (selected) this.inspectFeedItem(selected, false);
    }
  }

  private renderTimeline(items: OpsFeedItem[]): void {
    if (!this.timelineBars || !this.timelineMeta) return;
    this.timelineBars.replaceChildren();
    const now = Date.now();
    const range = this.ctx.map?.getTimeRange() ?? this.ctx.currentTimeRange;
    const oldest = items[items.length - 1]?.when.getTime() ?? now - 60 * 60_000;
    const duration = TIME_RANGE_MS[range] ?? Math.max(60 * 60_000, now - oldest);
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
    this.timelineMeta.textContent = `${items.length} reports · ${range.toUpperCase()}`;
  }

  // ---- inspector ----

  private inspectFeedItem(item: OpsFeedItem, updateUrl = true): void {
    this.selection = { kind: 'feed', item };
    if (updateUrl) this.setFocus(item.id);
    const content = this.beginInspector(
      item.alert ? 'Priority report' : 'Intelligence report',
      item.title,
      `${item.source} · ${formatTimeAgo(item.when)}`,
    );

    const badges = el('div', 'ops-inspector-badges');
    if (item.threat) badges.appendChild(badge(sentence(item.threat.level), `level-${item.threat.level}`));
    if (item.sourceCount > 1) badges.appendChild(badge(`${item.sourceCount} sources`, 'sources'));
    if (item.locationName) badges.appendChild(badge(item.locationName, 'location'));
    if (badges.childElementCount > 0) content.appendChild(badges);

    const summary = el('p', 'ops-inspector-copy');
    summary.textContent = item.snippet || 'Open the source report for the full context and verify material claims against corroborating evidence.';
    content.appendChild(summary);

    const facts = el('div', 'ops-inspector-facts');
    facts.append(
      fact('Updated', formatAbsoluteTime(item.when)),
      fact('Sources', String(item.sourceCount)),
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
        this.ctx.map?.setCenter(item.lat!, item.lon!, 5);
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

  private async inspectBrief(): Promise<void> {
    const loading = this.beginInspector('AI synthesis', 'Compiling the current picture', 'Cited · cached · public');
    const loadingCopy = el('p', 'ops-inspector-copy');
    loadingCopy.textContent = 'Loading the latest validated brief and its evidence trail…';
    loading.appendChild(loadingCopy);
    this.selection = { kind: 'brief', brief: null };
    this.openInspector();

    if (this.briefButton) {
      this.briefButton.disabled = true;
      this.briefButton.textContent = 'Loading';
    }
    const insights = await fetchServerInsights(5_000, true) ?? getServerInsights();
    if (this.briefButton) {
      this.briefButton.disabled = false;
      this.briefButton.textContent = 'Brief';
    }
    if (this.selection?.kind !== 'brief') return;

    const brief = insights ? buildVantageSynthesis(insights) : null;
    this.selection = { kind: 'brief', brief };
    if (!brief) {
      const unavailable = this.beginInspector('AI synthesis', 'Brief temporarily unavailable', 'Data plane degraded');
      const copy = el('p', 'ops-inspector-copy');
      copy.textContent = 'The cited snapshot is not fresh enough to display. Live reporting remains available in the feed while the next synthesis run completes.';
      unavailable.appendChild(copy);
      return;
    }

    const briefLabel = brief.generationMode === 'grounded-fallback'
      ? 'Cited synthesis · safety fallback'
      : brief.degraded
        ? 'AI synthesis · degraded'
        : 'AI synthesis';
    const content = this.beginInspector(
      briefLabel,
      'Global situation brief',
      brief.freshness,
    );
    const badges = el('div', 'ops-inspector-badges');
    badges.appendChild(badge(`${sentence(brief.confidence)} confidence`, brief.confidence === 'HIGH' ? 'sources' : 'location'));
    badges.appendChild(badge(`${brief.sources.length} sources`, 'sources'));
    content.appendChild(badges);

    const changedHeading = el('h3', 'ops-inspector-section-title');
    changedHeading.textContent = 'What changed';
    const changed = el('p', 'ops-inspector-copy ops-brief-copy');
    changed.textContent = brief.whatChanged;
    const whyHeading = el('h3', 'ops-inspector-section-title');
    whyHeading.textContent = 'Why it matters';
    const why = el('p', 'ops-inspector-copy');
    why.textContent = brief.whyItMatters;
    content.append(changedHeading, changed, whyHeading, why);

    if (brief.threads.length > 0) {
      const threadHeading = el('h3', 'ops-inspector-section-title');
      threadHeading.textContent = 'Leading threads';
      const threadList = el('ol', 'ops-brief-threads');
      for (const thread of brief.threads) {
        const item = el('li');
        item.textContent = thread.text;
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
        link.textContent = `[${source.index}] ${source.source} — ${source.title}`;
        list.appendChild(link);
      }
      content.append(evidenceTitle, list);
    }
  }

  private beginInspector(kicker: string, titleText: string, metaText?: string): HTMLElement {
    if (!this.inspector) return el('div');
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
    title.textContent = titleText;
    const content = el('div', 'ops-inspector-content');
    content.appendChild(title);
    this.inspector.replaceChildren(header, content);
    return content;
  }

  private openInspector(): void {
    if (!this.inspector || !this.body) return;
    this.inspector.hidden = false;
    this.body.classList.add('has-inspector');
    requestAnimationFrame(() => this.ctx.map?.resize?.());
  }

  private closeInspector(): void {
    if (!this.inspector || !this.body) return;
    this.selection = null;
    this.inspector.hidden = true;
    this.body.classList.remove('has-inspector');
    this.setFocus(null);
    this.syncFeedSelection();
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
    for (const [range, button] of this.timeButtons) {
      button.setAttribute('aria-pressed', range === active ? 'true' : 'false');
    }
    this.updateStatusLine();
  }

  private updateStatusLine(): void {
    if (!this.statusLine) return;
    const range = (this.ctx.map?.getTimeRange() ?? this.ctx.currentTimeRange).toUpperCase();
    if (VANTAGE_PUBLIC_MODE && !VANTAGE_RELAY_ENABLED) {
      this.statusLine.textContent = `Window ${range} · Air/ships pending`;
      return;
    }
    const ais = safeAisStatus();
    this.statusLine.textContent = `Window ${range} · AIS ${ais.connected ? 'live' : 'idle'}`;
  }

  private updateHud(): void {
    const scores = getCachedScores();
    const risk = scores?.strategicRisk ?? null;
    if (this.hudScore) this.hudScore.textContent = risk ? String(Math.round(risk.score)) : '--';
    if (this.hudLevel) {
      const level = risk?.level ?? 'low';
      this.hudLevel.textContent = risk ? sentence(level) : 'Pending';
      this.hudLevel.dataset.level = level;
    }
    if (this.hudBar) {
      const fraction = risk ? Math.max(0, Math.min(1, risk.score / 100)) : 0;
      this.hudBar.style.transform = `scaleX(${fraction})`;
    }

    const militaryFlights = this.ctx.intelligenceCache.military?.flights?.length ?? 0;
    const ais = safeAisStatus();
    const events = this.ctx.latestClusters.length || this.ctx.allNews.length;

    if (this.hudStats) {
      this.hudStats.replaceChildren(
        hudStat(VANTAGE_PUBLIC_MODE && !VANTAGE_RELAY_ENABLED ? '—' : militaryFlights, 'Mil air'),
        hudStat(VANTAGE_PUBLIC_MODE && !VANTAGE_RELAY_ENABLED ? '—' : ais.vessels, 'Vessels'),
        hudStat(events, 'Events'),
        hudStat(scores?.cii?.filter((score) => score.level === 'high' || score.level === 'critical').length ?? 0, 'High CII'),
      );
    }
    if (this.countAir) setCount(this.countAir, VANTAGE_PUBLIC_MODE && !VANTAGE_RELAY_ENABLED ? '—' : militaryFlights, 'air');
    if (this.countShips) setCount(this.countShips, VANTAGE_PUBLIC_MODE && !VANTAGE_RELAY_ENABLED ? '—' : ais.vessels, 'ships');
    if (this.countEvents) setCount(this.countEvents, events, 'events');
    this.updateStatusLine();
  }

  private toggleShortcuts(open: boolean): void {
    if (!this.shortcutsOverlay) return;
    this.shortcutsOverlay.hidden = !open;
    if (open) this.shortcutsOverlay.querySelector<HTMLButtonElement>('button')?.focus();
  }
}

// ---- small DOM/data helpers ----

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

function hudStat(value: number | string, label: string): HTMLElement {
  const wrap = el('span');
  const number = el('b');
  number.textContent = String(value);
  wrap.append(number, document.createTextNode(label));
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

function safeAisStatus(): { connected: boolean; vessels: number } {
  try {
    return getAisStatus();
  } catch {
    return { connected: false, vessels: 0 };
  }
}

function isEditableTarget(target: HTMLElement | null): boolean {
  if (!target) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
