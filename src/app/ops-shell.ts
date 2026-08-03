/**
 * OpsShell — the map-first operating-picture layout.
 *
 * Mounted after PanelLayoutManager.renderLayout()/createPanels() have built
 * the classic DOM. Instead of re-rendering the app, the shell:
 *   1. builds a fixed full-viewport grid (top bar / filter rail / body / bottom),
 *   2. ADOPTS the live elements it needs (#mapSection, #headerClock, #searchBtn,
 *      #unifiedSettingsMount, #authWidgetMount, #mapDimensionToggle) so all
 *      existing wiring keeps working,
 *   3. tucks the legacy panel grid into an off-screen dock (.ops-panel-dock) so
 *      every panel data pipeline stays alive while invisible.
 *
 * The classic dashboard remains reachable with ?classic=1 (App skips the shell).
 */
import type { AppContext } from '@/app/app-context';
import type { MapLayers, ClusteredEvent, NewsItem } from '@/types';
import type { TimeRange } from '@/components/MapContainer';
import { BRAND } from '@/config/brand';
import { getCachedScores } from '@/services/cached-risk-scores';
import { getAisStatus } from '@/services/maritime';

export interface OpsShellHooks {
  onToggleLayer: (layer: keyof MapLayers, enabled: boolean) => void;
}

interface LayerChipDef {
  key: keyof MapLayers;
  label: string;
  cssVar: string;
}

const LAYER_CHIPS: LayerChipDef[] = [
  { key: 'hotspots', label: 'Events', cssVar: '--ops-dom-events' },
  { key: 'conflicts', label: 'Strikes', cssVar: '--ops-dom-strikes' },
  { key: 'bases', label: 'Bases', cssVar: '--ops-dom-bases' },
  { key: 'military', label: 'Air', cssVar: '--ops-dom-air' },
  { key: 'ais', label: 'Ships', cssVar: '--ops-dom-ships' },
  { key: 'fires', label: 'Fires', cssVar: '--ops-dom-fires' },
  { key: 'satellites', label: 'Sats', cssVar: '--ops-dom-sats' },
  { key: 'gpsJamming', label: 'GPS Jam', cssVar: '--ops-dom-gps' },
];

const TIME_RANGES: TimeRange[] = ['1h', '6h', '24h', '48h', '7d', 'all'];

const FEED_LIMIT = 60;
const HUD_REFRESH_MS = 30_000;

export class OpsShell {
  private readonly ctx: AppContext;
  private readonly hooks: OpsShellHooks;
  private root: HTMLElement | null = null;
  private feedList: HTMLElement | null = null;
  private feedCount: HTMLElement | null = null;
  private chipButtons = new Map<keyof MapLayers, HTMLButtonElement>();
  private timeButtons = new Map<TimeRange, HTMLButtonElement>();
  private hudScore: HTMLElement | null = null;
  private hudLevel: HTMLElement | null = null;
  private hudBar: HTMLElement | null = null;
  private hudStats: HTMLElement | null = null;
  private countAir: HTMLElement | null = null;
  private countShips: HTMLElement | null = null;
  private countEvents: HTMLElement | null = null;
  private statusLine: HTMLElement | null = null;
  private hudTimer: ReturnType<typeof setInterval> | null = null;
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
    );
    document.body.appendChild(shell);
    this.root = shell;

    this.dockLegacyPanels();
    this.adoptMap();
    this.adoptHeaderControls();

    this.syncLayerChips();
    this.syncTimeChips(this.ctx.currentTimeRange);
    this.ctx.map?.onTimeRangeChanged((range) => this.syncTimeChips(range));

    this.renderFeed();
    this.updateHud();
    this.hudTimer = setInterval(() => this.updateHud(), HUD_REFRESH_MS);

    // The map was sized while its section sat in the legacy flow; re-measure
    // once it is absolutely positioned inside the shell.
    requestAnimationFrame(() => this.ctx.map?.resize?.());
  }

  destroy(): void {
    this.destroyed = true;
    if (this.hudTimer) clearInterval(this.hudTimer);
    this.root?.remove();
    this.root = null;
    document.body.classList.remove('ops-mode');
  }

  /** Called by the data loader whenever the news/cluster stores change. */
  onDataUpdated(): void {
    if (this.destroyed) return;
    this.renderFeed();
    this.updateHud();
  }

  /** Keep chips in sync when layers change from any origin (palette, URL, settings). */
  syncLayerChips(): void {
    for (const [key, btn] of this.chipButtons) {
      btn.setAttribute('aria-pressed', this.ctx.mapLayers[key] ? 'true' : 'false');
    }
  }

  // ---- construction ----

  private buildTopBar(): HTMLElement {
    const top = el('header', 'ops-top');

    const brand = el('div', 'ops-brand');
    brand.textContent = BRAND.name;
    const live = el('span', 'ops-live');
    live.textContent = 'LIVE';
    brand.appendChild(live);

    const chips = el('div', 'ops-chips');
    for (const def of LAYER_CHIPS) {
      const btn = el('button', 'ops-chip') as HTMLButtonElement;
      btn.type = 'button';
      btn.style.setProperty('--chip-color', `var(${def.cssVar})`);
      const dot = el('span', 'dot');
      btn.append(dot, document.createTextNode(def.label));
      btn.addEventListener('click', () => {
        const next = !this.ctx.mapLayers[def.key];
        this.hooks.onToggleLayer(def.key, next);
        btn.setAttribute('aria-pressed', next ? 'true' : 'false');
      });
      chips.appendChild(btn);
      this.chipButtons.set(def.key, btn);
    }

    const right = el('div', 'ops-top-right');
    const counts = el('div', 'ops-counts');
    this.countAir = el('span');
    this.countShips = el('span');
    this.countEvents = el('span');
    counts.append(this.countAir, this.countShips, this.countEvents);
    right.appendChild(counts);
    right.id = 'opsTopRight';

    top.append(brand, chips, right);
    return top;
  }

  private buildFilterRail(): HTMLElement {
    const rail = el('div', 'ops-filter');

    const timeSeg = el('div', 'ops-seg');
    for (const range of TIME_RANGES) {
      const btn = el('button', 'ops-seg-btn') as HTMLButtonElement;
      btn.type = 'button';
      btn.textContent = range === 'all' ? 'ALL' : range.toUpperCase();
      btn.addEventListener('click', () => {
        this.ctx.map?.setTimeRange(range);
        this.syncTimeChips(range);
      });
      timeSeg.appendChild(btn);
      this.timeButtons.set(range, btn);
    }

    const spacer = el('div', 'ops-filter-spacer');
    rail.append(timeSeg, spacer);
    return rail;
  }

  private buildBody(): HTMLElement {
    const body = el('div', 'ops-body');

    const feed = el('aside', 'ops-feed');
    const head = el('div', 'ops-feed-head');
    const label = el('span');
    label.textContent = 'LIVE FEED';
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

    const inspector = el('aside', 'ops-inspector');
    inspector.id = 'opsInspector';
    inspector.hidden = true;

    body.append(feed, mapArea, inspector);
    return body;
  }

  private buildHud(): HTMLElement {
    const hud = el('div', 'ops-hud');
    const label = el('div', 'ops-hud-label');
    label.textContent = 'ESCALATION INDEX';

    const score = el('div', 'ops-hud-score');
    this.hudScore = el('b');
    this.hudScore.textContent = '--';
    this.hudLevel = el('span', 'ops-hud-level');
    this.hudLevel.textContent = 'PENDING';
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
    bottom.appendChild(this.statusLine);
    return bottom;
  }

  // ---- adoption of legacy elements ----

  private dockLegacyPanels(): void {
    const dock = el('div', 'ops-panel-dock');
    dock.setAttribute('aria-hidden', 'true');
    for (const id of ['panelTabsMount', 'panelsGrid', 'mapBottomGrid']) {
      const node = document.getElementById(id);
      if (node) dock.appendChild(node);
    }
    document.body.appendChild(dock);
  }

  private adoptMap(): void {
    const mapSection = document.getElementById('mapSection');
    const mapArea = this.root?.querySelector('.ops-map');
    if (mapSection && mapArea) mapArea.appendChild(mapSection);
  }

  private adoptHeaderControls(): void {
    const right = this.root?.querySelector('.ops-top-right');
    if (right) {
      for (const id of ['headerClock', 'searchBtn', 'unifiedSettingsMount', 'authWidgetMount']) {
        const node = document.getElementById(id);
        if (node) right.appendChild(node);
      }
    }
    const controls = this.root?.querySelector('.ops-map-controls');
    const dimToggle = document.getElementById('mapDimensionToggle');
    if (controls && dimToggle) controls.appendChild(dimToggle);
  }

  // ---- live data ----

  private syncTimeChips(active: TimeRange): void {
    for (const [range, btn] of this.timeButtons) {
      btn.setAttribute('aria-pressed', range === active ? 'true' : 'false');
    }
    this.updateStatusLine();
  }

  private updateStatusLine(): void {
    if (!this.statusLine) return;
    const range = (this.ctx.map?.getTimeRange() ?? this.ctx.currentTimeRange).toUpperCase();
    const ais = safeAisStatus();
    this.statusLine.textContent = `WINDOW ${range} · AIS ${ais.connected ? 'LIVE' : 'IDLE'}`;
  }

  private renderFeed(): void {
    if (!this.feedList) return;
    const clusters = this.ctx.latestClusters;
    const items: Array<{ title: string; source: string; link: string; when: Date; alert: boolean }> =
      clusters.length > 0
        ? clusters.slice(0, FEED_LIMIT).map((c: ClusteredEvent) => ({
            title: c.primaryTitle,
            source: c.primarySource,
            link: c.primaryLink,
            when: c.lastUpdated,
            alert: c.isAlert,
          }))
        : this.ctx.allNews.slice(0, FEED_LIMIT).map((n: NewsItem) => ({
            title: n.title,
            source: n.source,
            link: n.link,
            when: n.pubDate,
            alert: n.isAlert,
          }));

    this.feedList.replaceChildren();
    if (this.feedCount) this.feedCount.textContent = items.length ? String(items.length) : '';

    if (items.length === 0) {
      const empty = el('div', 'ops-feed-empty');
      empty.textContent = 'Waiting for live reporting…';
      this.feedList.appendChild(empty);
      return;
    }

    for (const item of items) {
      const btn = el('button', 'ops-feed-item') as HTMLButtonElement;
      btn.type = 'button';
      const meta = el('div', 'meta');
      const src = el('span', 'src');
      src.textContent = item.source;
      const when = el('span');
      when.textContent = formatTimeAgo(item.when);
      meta.append(src, when);
      const title = el('div', 'title');
      title.textContent = item.title;
      btn.append(meta, title);
      btn.addEventListener('click', () => {
        window.open(item.link, '_blank', 'noopener,noreferrer');
      });
      this.feedList.appendChild(btn);
    }
  }

  private updateHud(): void {
    const scores = getCachedScores();
    const risk = scores?.strategicRisk ?? null;
    if (this.hudScore) this.hudScore.textContent = risk ? String(Math.round(risk.score)) : '--';
    if (this.hudLevel) {
      const level = risk?.level ?? 'low';
      this.hudLevel.textContent = risk ? level.toUpperCase() : 'PENDING';
      this.hudLevel.dataset.level = level;
    }
    if (this.hudBar) {
      const frac = risk ? Math.max(0, Math.min(1, risk.score / 100)) : 0;
      this.hudBar.style.transform = `scaleX(${frac})`;
    }

    const milFlights = this.ctx.intelligenceCache.military?.flights?.length ?? 0;
    const ais = safeAisStatus();
    const events = this.ctx.latestClusters.length || this.ctx.allNews.length;

    if (this.hudStats) {
      this.hudStats.replaceChildren(
        hudStat(milFlights, 'MIL AIR'),
        hudStat(ais.vessels, 'VESSELS'),
        hudStat(events, 'EVENTS'),
        hudStat(scores?.cii?.filter((c) => c.level === 'high' || c.level === 'critical').length ?? 0, 'HIGH CII'),
      );
    }

    if (this.countAir) setCount(this.countAir, milFlights, 'AIR');
    if (this.countShips) setCount(this.countShips, ais.vessels, 'SHIPS');
    if (this.countEvents) setCount(this.countEvents, events, 'EVENTS');

    this.updateStatusLine();
  }
}

// ---- small DOM helpers ----

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function hudStat(value: number, label: string): HTMLElement {
  const wrap = el('span');
  const b = el('b');
  b.textContent = String(value);
  wrap.append(b, document.createTextNode(label));
  return wrap;
}

function setCount(node: HTMLElement, value: number, label: string): void {
  node.replaceChildren();
  const b = el('b');
  b.textContent = String(value);
  node.append(b, document.createTextNode(` ${label}`));
}

function formatTimeAgo(when: Date): string {
  const mins = Math.max(0, Math.floor((Date.now() - when.getTime()) / 60_000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function safeAisStatus(): { connected: boolean; vessels: number } {
  try {
    return getAisStatus();
  } catch {
    return { connected: false, vessels: 0 };
  }
}
