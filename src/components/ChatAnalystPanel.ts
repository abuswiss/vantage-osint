import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { postProcessAnalystHtml } from '@/utils/analyst-markdown';
import { yieldToMain } from '@/utils/after-paint';
import { premiumFetch } from '@/services/premium-fetch';
import { getAuthState } from '@/services/auth-state';
import { readClientEntitlementBelief } from '@/services/panel-gating';
import {
  analystDenialMessage,
  isBillingVerificationDenial,
  PRO_VERIFICATION_RETRY_MESSAGE,
} from '@/services/analyst-denial';
import { classifyDenialResponse, type ClientEntitlementBelief } from '@/services/premium-denial';
import { reportEntitlementDesync } from '@/services/entitlement-desync-telemetry';
import { trackAnalystControlAction } from '@/services/analytics';
import { h, replaceChildren, setTrustedHtml, trustedHtml, type TrustedHtml } from '@/utils/dom-utils';
import { createConfidenceBadge, extractConfidenceLevel } from '@/utils/confidence';
import {
  isDashboardControlAction,
  parseAgentBusAction,
  type AgentBusAction,
  type DashboardControlAction,
} from '../../shared/agent-bus-actions';

const API_URL = '/api/chat-analyst';
const MAX_HISTORY = 20;
const DASHBOARD_CONTROL_STORAGE_KEY = 'wm-analyst-dashboard-control-enabled';

interface QuickAction {
  label: string;
  icon: string;
  query: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  { label: 'Situation',  icon: '🌍', query: "Summarize today's geopolitical situation" },
  { label: 'Markets',    icon: '📈', query: 'Key market moves, macro signals, and commodity moves today' },
  { label: 'Conflicts',  icon: '⚔️',  query: 'Top active conflicts and military developments' },
  { label: 'Forecasts',  icon: '🔮', query: 'Active forecasts and prediction market outlook' },
  { label: 'Risk',       icon: '⚠️',  query: 'Highest risk countries and instability hotspots' },
];

const DOMAINS = [
  { id: 'all', label: 'All' },
  { id: 'geo', label: 'Geo' },
  { id: 'market', label: 'Market' },
  { id: 'military', label: 'Military' },
  { id: 'economic', label: 'Economic' },
];

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface MetaEvent {
  sources: string[];
  degraded: boolean;
}

/** One entry from the terminal SSE sources event ({sources: [...]}) . */
interface CitationSource {
  index: number;
  source: string;
  title: string;
  url?: string;
}

interface StreamOutcome {
  status: 'done' | 'error' | 'incomplete';
  sources: CitationSource[] | null;
}

/**
 * Defensive parse of the terminal sources event payload. The event is new and
 * optional — if it never arrives (or arrives malformed), we return null and
 * [n] citation markers stay as plain text. Nothing breaks.
 */
function parseSourcesPayload(raw: unknown): CitationSource[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CitationSource[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.index !== 'number' || !Number.isInteger(rec.index)) continue;
    out.push({
      index: rec.index,
      source: typeof rec.source === 'string' ? rec.source : `Source ${rec.index}`,
      title: typeof rec.title === 'string' ? rec.title : '',
      ...(typeof rec.url === 'string' ? { url: rec.url } : {}),
    });
  }
  return out.length > 0 ? out : null;
}

/** Only http(s) URLs may become footer links; anything else renders as text. */
function sanitizeExternalUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Matches [n] citation markers emitted by the analyst markdown envelope. */
const CITATION_MARKER_RE = /\[(\d{1,3})\]/g;

type DashboardControlStatus = 'applied' | 'denied' | 'invalid' | 'skipped';

/**
 * Turn a failed /api/chat-analyst response into user-facing copy.
 *
 * A 403 has several causes and only one of them is "you need to buy Pro":
 * the route 403s on a missing plan (api/chat-analyst.ts:126), and the shared
 * gateway also 403s an unidentified caller and a failed entitlement lookup.
 * Telling a customer who paid minutes ago to buy a subscription — which is
 * what the old blanket `status === 403` branch did during the #5600 poison
 * window — is worse than saying nothing (#5608).
 *
 * Consumes the response body, so it is only called on the !ok path where the
 * stream is never read.
 */
async function describeDenial(
  res: Response,
  requestBelief: ClientEntitlementBelief,
  requestUserId: string | null,
): Promise<string> {
  const requestIdentityChanged = () => (getAuthState().user?.id ?? null) !== requestUserId;
  if (requestIdentityChanged()) throw new DOMException('account changed during analyst request', 'AbortError');
  // #5622: the route now answers an entitlement it could not VERIFY with a
  // retryable 503 + `X-Billing-Verification` instead of flattening it into the
  // 403 upsell. Both this check and the verdict-to-copy mapping live in
  // src/services/analyst-denial.ts so they are reachable from a test — this
  // module imports DOMPurify at scope and cannot be loaded by `tsx --test`.
  if (isBillingVerificationDenial(res.status, res.headers.get('X-Billing-Verification'))) {
    return PRO_VERIFICATION_RETRY_MESSAGE;
  }
  const verdict = await classifyDenialResponse(res, requestBelief);
  if (requestIdentityChanged()) throw new DOMException('account changed while reading analyst denial', 'AbortError');
  if (verdict === 'entitlement_desync') reportEntitlementDesync('chat-analyst');
  return analystDenialMessage(res.status, verdict);
}

interface DashboardControlResult {
  ok: boolean;
  status: DashboardControlStatus;
  actionType?: DashboardControlAction['type'];
  label?: string;
  reason?: string;
  message: string;
  targets: Array<{ target: string; status: DashboardControlStatus; reason?: string }>;
}

type DashboardActionHandler = (action: DashboardControlAction) => DashboardControlResult;

// Narrow allowlist: text formatting, headings + tables only. No img/a/iframe
// so prompt-injected or hallucinated URLs cannot trigger third-party requests.
// h2–h4 admit the markdown envelope's '### Key points' / '### Confidence' /
// '### Watch' section headings (styled like .chat-section-header in main.css).
const ANALYST_PURIFY_CONFIG = {
  ALLOWED_TAGS: ['p', 'strong', 'em', 'b', 'i', 'br', 'hr',
    'h2', 'h3', 'h4',
    'ul', 'ol', 'li', 'code', 'pre',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'div', 'span'],
  ALLOWED_ATTR: ['class'],
  ALLOW_DATA_ATTR: false,
};

function renderMarkdown(raw: string): TrustedHtml {
  const sanitized = DOMPurify.sanitize(marked.parse(raw) as string, ANALYST_PURIFY_CONFIG);
  return trustedHtml(
    postProcessAnalystHtml(sanitized as string),
    'Chat analyst markdown is sanitized by DOMPurify before insertion',
  );
}

function loadDashboardControlEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(DASHBOARD_CONTROL_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveDashboardControlEnabled(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(DASHBOARD_CONTROL_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch { /* storage unavailable */ }
}

export class ChatAnalystPanel extends Panel {
  private history: ChatMessage[] = [];
  private domainFocus = 'all';
  private streamAbort: AbortController | null = null;
  private isStreaming = false;
  private dashboardActionHandler: DashboardActionHandler | null = null;
  private dashboardControlEnabled = loadDashboardControlEnabled();
  private dashboardControlPaused = false;
  private messagesEl!: HTMLElement;
  private inputEl: HTMLTextAreaElement | null = null;
  private controlToggleEl: HTMLInputElement | null = null;
  private controlStatusEl: HTMLElement | null = null;
  private controlPauseBtn: HTMLButtonElement | null = null;
  private contentDelegationAttached = false;

  constructor() {
    super({
      id: 'chat-analyst',
      title: 'WM Analyst',
      premium: 'locked',
      defaultRowSpan: 2,
      infoTooltip: t('components.chatAnalyst.infoTooltip'),
    });
    this.buildUI();
  }

  public setDashboardActionHandler(handler: DashboardActionHandler): void {
    this.dashboardActionHandler = handler;
  }

  private buildUI(): void {
    const wrapper = h('div', { className: 'chat-analyst-wrapper' });

    // Domain filter chips
    const chipBar = h('div', { className: 'chat-analyst-chips' });
    for (const d of DOMAINS) {
      const chip = h('button', {
        className: `chat-chip${d.id === this.domainFocus ? ' active' : ''}`,
        dataset: { domain: d.id },
      }, d.label);
      chipBar.appendChild(chip);
    }

    const controlBar = this.createDashboardControlBar();

    // Messages container
    const messages = h('div', { className: 'chat-analyst-messages' });
    this.messagesEl = messages;

    // Quick actions bar
    const quickBar = h('div', { className: 'chat-analyst-quick' });
    for (const qa of QUICK_ACTIONS) {
      const btn = h('button', {
        className: 'chat-quick-btn',
        dataset: { quickAction: qa.query },
      }, `${qa.icon} ${qa.label}`);
      quickBar.appendChild(btn);
    }

    // Input row
    const inputRow = h('div', { className: 'chat-analyst-input-row' });
    const textarea = document.createElement('textarea');
    textarea.className = 'chat-analyst-input';
    textarea.placeholder = 'Ask the analyst...';
    textarea.rows = 2;
    this.inputEl = textarea;

    const sendBtn = h('button', { className: 'chat-analyst-send', dataset: { action: 'send' } }, '▶');
    const clearBtn = h('button', { className: 'chat-analyst-clear', dataset: { action: 'clear' } }, '✕');
    const exportBtn = h('button', { className: 'chat-analyst-export', dataset: { action: 'export' } }, '↓');

    inputRow.appendChild(textarea);
    inputRow.appendChild(clearBtn);
    inputRow.appendChild(exportBtn);
    inputRow.appendChild(sendBtn);

    wrapper.appendChild(chipBar);
    wrapper.appendChild(controlBar);
    wrapper.appendChild(messages);
    wrapper.appendChild(quickBar);
    wrapper.appendChild(inputRow);

    replaceChildren(this.content, wrapper);

    this.showWelcome();
    this.updateDashboardControlUi();
    this.attachListeners();
  }

  private createDashboardControlBar(): HTMLElement {
    const bar = h('div', { className: 'chat-analyst-control-bar' });
    const label = h('label', { className: 'chat-control-toggle-label' });
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'chat-control-toggle';
    toggle.dataset.controlToggle = 'dashboard';
    this.controlToggleEl = toggle;
    label.appendChild(toggle);
    label.appendChild(document.createTextNode('Control dashboard'));

    const status = h('span', { className: 'chat-control-status' });
    this.controlStatusEl = status;

    const pauseBtn = h('button', {
      className: 'chat-control-pause',
      dataset: { action: 'toggle-control-pause' },
      type: 'button',
    }, 'Pause') as HTMLButtonElement;
    this.controlPauseBtn = pauseBtn;

    bar.appendChild(label);
    bar.appendChild(status);
    bar.appendChild(pauseBtn);
    return bar;
  }

  private attachListeners(): void {
    // Click + keydown are both delegated on this.content (the persistent
    // panel content div), so attaching exactly once survives every buildUI()
    // re-render — including the FREE→PRO unlock rebuild path. Re-attaching
    // would duplicate handlers and fire send() N times per Enter.
    if (this.contentDelegationAttached) return;
    this.contentDelegationAttached = true;

    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      const chip = target.closest('[data-domain]') as HTMLElement | null;
      if (chip) {
        this.setDomain(chip.dataset.domain ?? 'all');
        return;
      }

      const citation = target.closest('.chat-citation') as HTMLElement | null;
      if (citation) {
        this.handleCitationClick(citation);
        return;
      }

      const qa = target.closest('[data-quick-action]') as HTMLElement | null;
      if (qa) {
        const query = qa.dataset.quickAction ?? '';
        if (query) this.send(query);
        return;
      }

      const action = target.closest('[data-action]') as HTMLElement | null;
      if (action) {
        const a = action.dataset.action;
        if (a === 'send') this.sendFromInput();
        else if (a === 'clear') this.clear();
        else if (a === 'export') this.exportChat();
        else if (a === 'toggle-control-pause') this.toggleDashboardControlPause();
      }
    });

    this.content.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement | null;
      if (target?.dataset?.controlToggle === 'dashboard') {
        this.setDashboardControlEnabled(Boolean(target.checked));
      }
    });

    this.content.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (!target || target !== this.inputEl) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendFromInput();
      }
    });
  }

  private setDashboardControlEnabled(enabled: boolean): void {
    this.dashboardControlEnabled = enabled;
    if (!enabled) this.dashboardControlPaused = false;
    saveDashboardControlEnabled(enabled);
    this.updateDashboardControlUi();
  }

  private toggleDashboardControlPause(): void {
    if (!this.dashboardControlEnabled) return;
    this.dashboardControlPaused = !this.dashboardControlPaused;
    this.updateDashboardControlUi();
  }

  private updateDashboardControlUi(): void {
    if (this.controlToggleEl) this.controlToggleEl.checked = this.dashboardControlEnabled;
    if (this.controlStatusEl) {
      this.controlStatusEl.textContent = this.dashboardControlEnabled
        ? (this.dashboardControlPaused ? 'Paused' : 'Active')
        : 'Off';
      this.controlStatusEl.dataset.state = this.dashboardControlEnabled
        ? (this.dashboardControlPaused ? 'paused' : 'active')
        : 'off';
    }
    if (this.controlPauseBtn) {
      this.controlPauseBtn.disabled = !this.dashboardControlEnabled;
      this.controlPauseBtn.textContent = this.dashboardControlPaused ? 'Resume' : 'Pause';
    }
  }

  private setDomain(domain: string): void {
    this.domainFocus = domain;
    const chips = this.content.querySelectorAll('[data-domain]');
    for (const chip of chips) {
      const el = chip as HTMLElement;
      el.classList.toggle('active', el.dataset.domain === domain);
    }
  }

  private sendFromInput(): void {
    if (!this.inputEl || this.isStreaming) return;
    const query = this.inputEl.value.trim();
    if (!query) return;
    this.inputEl.value = '';
    this.send(query);
  }

  private showWelcome(): void {
    const bubble = h('div', { className: 'chat-msg chat-msg-assistant' },
      h('div', { className: 'chat-msg-label' }, 'ANALYST'),
      h('div', { className: 'chat-msg-body' },
        'Ready. I have live context across geopolitical, market, military, and economic domains. Ask anything.',
      ),
    );
    replaceChildren(this.messagesEl, bubble);
  }

  private appendMessage(role: 'user' | 'assistant', content: string): void {
    const label = role === 'user' ? 'YOU' : 'ANALYST';
    const body = h('div', { className: 'chat-msg-body' });
    if (role === 'assistant') {
      this.renderMarkdownDeferred(body, content);
    } else {
      body.textContent = content;
    }
    const bubble = h('div', { className: `chat-msg chat-msg-${role}` },
      h('div', { className: 'chat-msg-label' }, label),
      body,
    );
    this.messagesEl.appendChild(bubble);
    // The assistant branch scrolls inside renderMarkdownDeferred (after its DOM
    // lands); the user branch renders synchronously above, so scroll now.
    if (role !== 'assistant') this.scrollToBottom();
  }

  private appendStreamingBubble(): { bubble: HTMLElement; body: HTMLElement } {
    const body = h('div', { className: 'chat-msg-body' },
      h('span', { className: 'chat-streaming-dot' }),
    );
    const bubble = h('div', { className: 'chat-msg chat-msg-assistant chat-msg-streaming' },
      h('div', { className: 'chat-msg-label' }, 'ANALYST'),
      body,
    );
    this.messagesEl.appendChild(bubble);
    this.scrollToBottom();
    return { bubble, body };
  }

  private renderSourceChips(bubble: HTMLElement, meta: MetaEvent): void {
    if (meta.sources.length === 0 && !meta.degraded) return;
    const chipsRow = document.createElement('div');
    chipsRow.className = 'chat-source-chips';
    for (const src of meta.sources) {
      const chip = document.createElement('span');
      chip.className = 'chat-source-chip';
      chip.textContent = src;
      chipsRow.appendChild(chip);
    }
    if (meta.degraded) {
      const warn = document.createElement('span');
      warn.className = 'chat-source-chip chat-source-chip--warn';
      warn.textContent = '⚠ partial';
      chipsRow.appendChild(warn);
    }
    // Insert chips row before the body element inside the bubble
    const body = bubble.querySelector('.chat-msg-body');
    if (body) bubble.insertBefore(chipsRow, body);
  }

  private renderActionChip(bubble: HTMLElement, action: unknown): void {
    const parsed = parseAgentBusAction(action);
    if (!parsed.ok) {
      this.renderDashboardControlStatus(bubble, {
        ok: false,
        status: 'invalid',
        reason: 'invalid_action',
        message: 'Analyst sent an invalid dashboard action.',
        targets: [],
      });
      return;
    }

    const parsedAction = parsed.action;
    if (isDashboardControlAction(parsedAction)) {
      this.renderDashboardControlAction(bubble, parsedAction);
      return;
    }
    if (parsedAction.type !== 'suggest-widget') return;

    const chip = document.createElement('button');
    chip.className = 'chat-action-chip';
    chip.textContent = `${parsedAction.label} →`;
    chip.addEventListener('click', () => {
      this.element.dispatchEvent(new CustomEvent('wm:open-widget-creator', {
        bubbles: true,
        detail: { initialMessage: parsedAction.prefill },
      }));
    });
    const body = bubble.querySelector('.chat-msg-body');
    if (body) bubble.insertBefore(chip, body);
    else bubble.appendChild(chip);
  }

  private renderDashboardControlAction(bubble: HTMLElement, action: DashboardControlAction): void {
    let result: DashboardControlResult;
    if (!this.dashboardControlEnabled) {
      result = this.skippedDashboardAction(action, 'control_disabled', 'Dashboard control is off.');
    } else if (this.dashboardControlPaused) {
      result = this.skippedDashboardAction(action, 'control_paused', 'Dashboard control is paused.');
    } else if (!this.dashboardActionHandler) {
      result = this.skippedDashboardAction(action, 'context_unavailable', 'Dashboard context is unavailable.');
    } else {
      result = this.dashboardActionHandler(action);
    }

    if (result.actionType) {
      trackAnalystControlAction(result.actionType, result.status, result.reason);
    }
    this.renderDashboardControlStatus(bubble, result, action);
  }

  private skippedDashboardAction(action: DashboardControlAction, reason: string, message: string): DashboardControlResult {
    return {
      ok: false,
      status: 'skipped',
      actionType: action.type,
      label: action.label,
      reason,
      message,
      targets: [],
    };
  }

  private renderDashboardControlStatus(
    bubble: HTMLElement,
    result: DashboardControlResult,
    action?: AgentBusAction,
  ): void {
    const chip = document.createElement('span');
    chip.className = `chat-action-chip chat-action-chip--control chat-action-chip--${result.ok ? 'applied' : result.status}`;
    chip.textContent = result.ok
      ? `Applied: ${result.label ?? action?.type ?? 'dashboard action'}`
      : `${result.label ?? action?.type ?? 'Dashboard action'} not applied`;
    chip.title = result.message;
    const body = bubble.querySelector('.chat-msg-body');
    if (body) bubble.insertBefore(chip, body);
    else bubble.appendChild(chip);
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }

  /**
   * Whether the user is currently reading the bottom of the transcript.
   * Progressive stream renders only keep the view pinned when this is true —
   * a user who scrolled up to re-read is never yanked back down.
   */
  private isPinnedToBottom(): boolean {
    const el = this.messagesEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  private setSendDisabled(disabled: boolean): void {
    const btn = this.content.querySelector('[data-action="send"]') as HTMLButtonElement | null;
    if (btn) btn.disabled = disabled;
    if (this.inputEl) this.inputEl.disabled = disabled;
  }

  async send(query: string): Promise<void> {
    if (this.isStreaming) return;
    this.isStreaming = true;
    this.setSendDisabled(true);

    const trimmedQuery = query.trim().slice(0, 500);
    if (!trimmedQuery) {
      this.isStreaming = false;
      this.setSendDisabled(false);
      return;
    }

    this.appendMessage('user', trimmedQuery);

    const trimmedHistory = this.history.slice(-MAX_HISTORY).map((m) => ({
      role: m.role,
      content: m.content.slice(0, 800),
    }));

    const { bubble, body: streamingBody } = this.appendStreamingBubble();
    let accumulatedText = '';

    const controller = new AbortController();
    this.streamAbort = controller;
    const requestAuthState = getAuthState();
    const requestUserId = requestAuthState.user?.id ?? null;
    const requestBelief = readClientEntitlementBelief(requestAuthState);

    try {
      const res = await premiumFetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          history: trimmedHistory,
          query: trimmedQuery,
          domainFocus: this.domainFocus,
          // geoContext (ISO-2 country focus) is supported by the API but wired in Phase 2
          // when the panel can read the map's selected country. Agent callers can pass it directly.
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        this.finalizeStreamingBubble(
          streamingBody,
          `⚠ ${await describeDenial(res, requestBelief, requestUserId)}`,
          false,
        );
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        this.finalizeStreamingBubble(streamingBody, '⚠ Stream unavailable.', false);
        return;
      }

      const outcome = await this.readStream(reader, bubble, streamingBody, (text) => { accumulatedText = text; });
      if (outcome.status === 'error') return;
      if (outcome.status === 'done') {
        this.finalizeStreamingBubble(streamingBody, accumulatedText, true, outcome.sources);
        this.pushHistory(trimmedQuery, accumulatedText);
        return;
      }

      // Stream ended without a done event — response was truncated mid-stream
      if (accumulatedText) {
        this.finalizeStreamingBubble(streamingBody, `${accumulatedText}\n\n⚠ *Response may be incomplete.*`, false, outcome.sources);
        // Do not push to history — a truncated answer would corrupt the conversation context
      } else {
        this.finalizeStreamingBubble(streamingBody, '⚠ Response cut off. Try again.', false);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (accumulatedText) {
          this.finalizeStreamingBubble(streamingBody, `${accumulatedText}\n\n*Response cut off.*`, true);
        } else {
          this.finalizeStreamingBubble(streamingBody, '⚠ Request cancelled.', false);
        }
      } else {
        this.finalizeStreamingBubble(streamingBody, '⚠ Network error. Try again.', false);
      }
    } finally {
      // Only tear down the shared streaming state if we still OWN it. Every
      // exit path here follows an await, and clear() resets isStreaming, so a
      // user who clears mid-flight can start a second send before this block
      // runs — unconditionally nulling streamAbort would then cancel-proof the
      // NEW stream and leave the send button stuck. Keying on controller
      // identity makes a superseded invocation clean up only its own bubble.
      if (this.streamAbort === controller) {
        this.streamAbort = null;
        this.isStreaming = false;
        this.setSendDisabled(false);
      }
      bubble.classList.remove('chat-msg-streaming');
    }
  }

  private pushHistory(query: string, response: string): void {
    this.history.push({ role: 'user', content: query });
    this.history.push({ role: 'assistant', content: response });
    if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY);
  }

  private async readStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    bubble: HTMLElement,
    bodyEl: HTMLElement,
    onToken: (text: string) => void,
  ): Promise<StreamOutcome> {
    const decoder = new TextDecoder();
    let buf = '';
    let accumulated = '';
    let sources: CitationSource[] | null = null;

    // Progressive markdown: re-render the in-progress bubble through the same
    // sanitized marked+DOMPurify pipeline as the final message, throttled to
    // ~10Hz on requestAnimationFrame so per-token chunks never trigger full
    // reflows. `closed` (set in the finally) stops a queued frame from firing
    // after finalizeStreamingBubble() has written the decorated final DOM.
    const RENDER_INTERVAL_MS = 100;
    let closed = false;
    let renderQueued = false;
    let lastRenderAt = 0;
    const renderProgress = () => {
      renderQueued = false;
      if (closed || !bodyEl.isConnected) return;
      lastRenderAt = performance.now();
      const pinned = this.isPinnedToBottom();
      setTrustedHtml(bodyEl, renderMarkdown(accumulated));
      if (pinned) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    };
    const queueRender = () => {
      if (renderQueued || closed) return;
      renderQueued = true;
      const wait = Math.max(0, RENDER_INTERVAL_MS - (performance.now() - lastRenderAt));
      if (wait === 0) requestAnimationFrame(renderProgress);
      else setTimeout(() => requestAnimationFrame(renderProgress), wait);
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const payload = JSON.parse(line.slice(6)) as {
              delta?: string;
              done?: boolean;
              error?: string;
              meta?: MetaEvent;
              action?: unknown;
              sources?: unknown;
            };
            if (payload.error) {
              this.finalizeStreamingBubble(bodyEl, '⚠ Analyst unavailable. Try again shortly.', false);
              return { status: 'error', sources: null };
            }
            if (payload.meta) {
              this.renderSourceChips(bubble, payload.meta);
            }
            if (payload.action) {
              this.renderActionChip(bubble, payload.action);
            }
            if (payload.sources !== undefined) {
              // Terminal citation-metadata event; absent or malformed → null,
              // and [n] markers simply stay plain text.
              sources = parseSourcesPayload(payload.sources) ?? sources;
            }
            if (payload.delta) {
              accumulated += payload.delta;
              onToken(accumulated);
              queueRender();
            }
            if (payload.done) {
              flushFinal();
              return { status: 'done', sources };
            }
          } catch { /* malformed SSE chunk */ }
        }
      }
      flushFinal();
      return { status: 'incomplete', sources };
    } finally {
      closed = true;
    }

    // Leave the bubble textually complete even before finalizeStreamingBubble()
    // decorates it — callers (and tests) may observe the body right after
    // readStream resolves, between throttled progressive frames.
    function flushFinal(): void {
      if (closed || !accumulated) return;
      closed = true;
      setTrustedHtml(bodyEl, renderMarkdown(accumulated));
    }
  }

  // Defer the synchronous DOMPurify+marked sanitize off the current task so the
  // interaction/stream paint lands first — cuts INP processing time (#4537).
  // Fire-and-forget (no async ripple through the sync streaming call sites);
  // guarded so a detached bubble (panel closed mid-flight) is skipped.
  private renderMarkdownDeferred(el: HTMLElement, content: string, sources?: CitationSource[] | null): void {
    void yieldToMain().then(() => {
      if (!el.isConnected) return;
      const pinned = this.isPinnedToBottom();
      setTrustedHtml(el, renderMarkdown(content));
      if (sources?.length) {
        this.decorateCitations(el, sources);
        const bubble = el.closest('.chat-msg') as HTMLElement | null;
        if (bubble) this.buildSourcesFooter(bubble, sources);
      }
      this.applyConfidenceBadge(el, content);
      // Scroll AFTER the markdown DOM lands — rendered markdown (headers, code
      // fences, lists) is taller than the raw streaming text, so scrolling before
      // this undershoots the true bottom on every completion (#4537 follow-up).
      // Only when the user was already at the bottom — never yank a reader back.
      if (pinned) this.scrollToBottom();
    });
  }

  /**
   * Replace [n] markers in the rendered message with inline citation chips —
   * but only for indices present in the sources metadata. Without metadata
   * this is never called and markers remain plain text.
   */
  private decorateCitations(bodyEl: HTMLElement, sources: CitationSource[]): void {
    const byIndex = new Map(sources.map((s) => [s.index, s]));
    const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if ((n.parentElement)?.closest('code, pre')) continue;
      textNodes.push(n as Text);
    }
    for (const node of textNodes) {
      const text = node.nodeValue ?? '';
      CITATION_MARKER_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      let last = 0;
      let frag: DocumentFragment | null = null;
      while ((match = CITATION_MARKER_RE.exec(text))) {
        const idx = Number(match[1]);
        const src = byIndex.get(idx);
        if (!src) continue;
        frag ??= document.createDocumentFragment();
        frag.appendChild(document.createTextNode(text.slice(last, match.index)));
        frag.appendChild(this.createCitationChip(idx, src));
        last = match.index + match[0].length;
      }
      if (!frag) continue;
      frag.appendChild(document.createTextNode(text.slice(last)));
      node.replaceWith(frag);
    }
  }

  private createCitationChip(idx: number, src: CitationSource): HTMLButtonElement {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chat-citation';
    chip.dataset.citation = String(idx);
    chip.textContent = `[${idx}]`;
    const label = src.title ? `${src.source} — ${src.title}` : src.source;
    chip.title = label;
    chip.setAttribute('aria-label', `Source ${idx}: ${label}`);
    return chip;
  }

  private buildSourcesFooter(bubble: HTMLElement, sources: CitationSource[]): void {
    if (bubble.querySelector('.chat-sources-footer')) return;
    const footer = document.createElement('div');
    footer.className = 'chat-sources-footer';
    footer.hidden = true;
    for (const src of sources) {
      const entry = document.createElement('div');
      entry.className = 'chat-source-entry';
      entry.dataset.sourceIndex = String(src.index);

      const marker = document.createElement('span');
      marker.className = 'chat-source-entry-index';
      marker.textContent = `[${src.index}]`;
      entry.appendChild(marker);

      const safeUrl = sanitizeExternalUrl(src.url);
      const label = document.createElement(safeUrl ? 'a' : 'span');
      label.className = 'chat-source-entry-label';
      if (safeUrl && label instanceof HTMLAnchorElement) {
        label.href = safeUrl;
        label.target = '_blank';
        label.rel = 'noopener noreferrer';
      }
      const name = document.createElement('span');
      name.className = 'chat-source-entry-name';
      name.textContent = src.source;
      label.appendChild(name);
      if (src.title) label.appendChild(document.createTextNode(` — ${src.title}`));
      entry.appendChild(label);

      footer.appendChild(entry);
    }
    bubble.appendChild(footer);
  }

  private handleCitationClick(chip: HTMLElement): void {
    const bubble = chip.closest('.chat-msg');
    const footer = bubble?.querySelector('.chat-sources-footer') as HTMLElement | null;
    if (!footer) return; // sources metadata never arrived — chip is decorative only
    const idx = chip.dataset.citation ?? '';
    const entry = footer.querySelector(`[data-source-index="${idx}"]`) as HTMLElement | null;
    if (footer.hidden) {
      footer.hidden = false;
      footer.dataset.openFor = idx;
      this.flashSourceEntry(entry);
    } else if (footer.dataset.openFor === idx) {
      footer.hidden = true;
      delete footer.dataset.openFor;
    } else {
      footer.dataset.openFor = idx;
      this.flashSourceEntry(entry);
    }
  }

  private flashSourceEntry(entry: HTMLElement | null): void {
    if (!entry) return;
    entry.classList.remove('chat-source-flash');
    void entry.offsetWidth; // restart the flash animation
    entry.classList.add('chat-source-flash');
    entry.scrollIntoView({ block: 'nearest' });
  }

  /** Mirror a '### Confidence' section as a tinted badge in the bubble corner. */
  private applyConfidenceBadge(bodyEl: HTMLElement, content: string): void {
    const level = extractConfidenceLevel(content);
    if (!level) return;
    const bubble = bodyEl.closest('.chat-msg') as HTMLElement | null;
    if (!bubble) return;
    bubble.querySelector(':scope > .wm-confidence-badge')?.remove();
    bubble.appendChild(createConfidenceBadge(level));
  }

  private finalizeStreamingBubble(
    bodyEl: HTMLElement,
    text: string,
    success: boolean,
    sources?: CitationSource[] | null,
  ): void {
    if (!success) bodyEl.classList.add('chat-msg-error');
    // renderMarkdownDeferred scrolls to bottom after the markdown DOM is written.
    this.renderMarkdownDeferred(bodyEl, text, sources);
  }

  clear(): void {
    this.history = [];
    this.streamAbort?.abort();
    this.streamAbort = null;
    this.isStreaming = false;
    this.setSendDisabled(false);
    this.showWelcome();
  }

  private exportChat(): void {
    if (this.history.length === 0) return;
    const lines = [`# WM Analyst Session\n*Exported: ${new Date().toISOString()}*\n`];
    for (const msg of this.history) {
      const role = msg.role === 'user' ? '**You**' : '**Analyst**';
      lines.push(`\n${role}:\n${msg.content}`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wm-analyst-session-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Panel.unlockPanel() does `replaceChildren(this.content)` (empties it)
  // when a previously-locked panel transitions to unlocked. The chat surface
  // (chips, messages, quick actions, input row) lives entirely in buildUI()
  // and is only constructed once in the ctor — without a rebuild here, the
  // body would stay empty after the FREE→PRO unlock fired by
  // panel-layout.ts:updatePanelGating(). Re-detect via querySelector so we
  // only pay the cost when the wipe actually happened.
  override unlockPanel(): void {
    super.unlockPanel();
    if (!this.content.querySelector('.chat-analyst-wrapper')) {
      this.buildUI();
    }
  }

  override destroy(): void {
    this.streamAbort?.abort();
    this.streamAbort = null;
    super.destroy();
  }
}
