export type VantageServiceState =
  | 'ready'
  | 'degraded'
  | 'stale'
  | 'waiting'
  | 'unknown'
  | 'missing'
  | 'error'
  | 'unavailable'
  | 'not-configured';

interface CacheHealth {
  status: VantageServiceState;
  ageSeconds: number | null;
}

export interface VantageHealthSnapshot {
  status: 'ready' | 'degraded' | 'unavailable';
  checkedAt: string;
  services: {
    redis: VantageServiceState;
    news: CacheHealth;
    insights: CacheHealth;
    risk: CacheHealth;
    relay: {
      status: VantageServiceState;
      air: VantageServiceState;
      ships: VantageServiceState;
    };
  };
}

export type CoverageState = 'current' | 'delayed' | 'unavailable' | 'checking';

export interface CoverageSurface {
  id: 'reports' | 'brief' | 'risk' | 'air' | 'ships';
  label: string;
  state: CoverageState;
  detail: string;
  ageSeconds: number | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isServiceState(value: unknown): value is VantageServiceState {
  return typeof value === 'string' && [
    'ready', 'degraded', 'stale', 'waiting', 'unknown', 'missing', 'error',
    'unavailable', 'not-configured',
  ].includes(value);
}

function cacheHealth(value: unknown): CacheHealth | null {
  if (!isObject(value) || !isServiceState(value.status)) return null;
  return {
    status: value.status,
    ageSeconds: typeof value.ageSeconds === 'number' && Number.isFinite(value.ageSeconds)
      ? Math.max(0, value.ageSeconds)
      : null,
  };
}

export function parseVantageHealth(value: unknown): VantageHealthSnapshot | null {
  if (!isObject(value) || !['ready', 'degraded', 'unavailable'].includes(String(value.status))) return null;
  if (typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt)) || !isObject(value.services)) return null;
  const news = cacheHealth(value.services.news);
  const insights = cacheHealth(value.services.insights);
  const risk = cacheHealth(value.services.risk);
  const relay = value.services.relay;
  if (!news || !insights || !risk || !isServiceState(value.services.redis) || !isObject(relay)) return null;
  if (!isServiceState(relay.status) || !isServiceState(relay.air) || !isServiceState(relay.ships)) return null;
  return {
    status: value.status as VantageHealthSnapshot['status'],
    checkedAt: value.checkedAt,
    services: {
      redis: value.services.redis,
      news,
      insights,
      risk,
      relay: { status: relay.status, air: relay.air, ships: relay.ships },
    },
  };
}

export async function fetchVantageHealth(signal?: AbortSignal): Promise<VantageHealthSnapshot | null> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (signal?.aborted) return null;
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 8_000);
  try {
    const response = await fetch('/api/vantage-health', {
      cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal,
    });
    if (!response.ok && response.status !== 503) return null;
    return parseVantageHealth(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function coverageState(status: VantageServiceState): CoverageState {
  if (status === 'ready') return 'current';
  if (status === 'degraded' || status === 'stale' || status === 'waiting' || status === 'unknown') return 'delayed';
  return 'unavailable';
}

function cacheDetail(label: string, health: CacheHealth): string {
  if (health.status === 'ready') return health.ageSeconds === null
    ? `${label} is current.`
    : `${label} was refreshed ${formatCoverageAge(health.ageSeconds)} ago.`;
  if (health.status === 'stale') return `${label} is older than its freshness window.`;
  if (health.status === 'unknown') return `${label} is present, but freshness could not be verified.`;
  if (health.status === 'missing') return `${label} has not published a current snapshot.`;
  return `${label} is temporarily unavailable.`;
}

export function getCoverageSurfaces(snapshot: VantageHealthSnapshot | null, checkFailed = false): CoverageSurface[] {
  if (!snapshot) {
    const surfaces: ReadonlyArray<readonly [CoverageSurface['id'], string]> = [
      ['reports', 'Reports'],
      ['brief', 'Brief'],
      ['risk', 'Risk'],
      ['air', 'Air'],
      ['ships', 'Ships'],
    ];
    return surfaces.map(([id, label]) => ({
      id,
      label,
      state: checkFailed ? 'unavailable' as const : 'checking' as const,
      detail: checkFailed
        ? 'The readiness check could not be completed. Try checking again.'
        : 'Readiness has not been verified yet.',
      ageSeconds: null,
    }));
  }
  const { services } = snapshot;
  return [
    {
      id: 'reports',
      label: 'Reports',
      state: coverageState(services.news.status),
      detail: cacheDetail('The report feed', services.news),
      ageSeconds: services.news.ageSeconds,
    },
    {
      id: 'brief',
      label: 'Brief',
      state: coverageState(services.insights.status),
      detail: cacheDetail('The cited brief', services.insights),
      ageSeconds: services.insights.ageSeconds,
    },
    {
      id: 'risk',
      label: 'Risk',
      state: coverageState(services.risk.status),
      detail: cacheDetail('The risk snapshot', services.risk),
      ageSeconds: services.risk.ageSeconds,
    },
    {
      id: 'air',
      label: 'Air',
      state: coverageState(services.relay.air),
      detail: relayDetail('Air tracking', services.relay.air),
      ageSeconds: null,
    },
    {
      id: 'ships',
      label: 'Ships',
      state: coverageState(services.relay.ships),
      detail: relayDetail('Ship tracking', services.relay.ships),
      ageSeconds: null,
    },
  ];
}

function relayDetail(label: string, state: VantageServiceState): string {
  if (state === 'ready') return `${label} is receiving live relay data.`;
  if (state === 'waiting') return `${label} is connected but has not received current positions.`;
  if (state === 'degraded') return `${label} is receiving partial relay coverage.`;
  if (state === 'not-configured') return `${label} is not provisioned for this deployment.`;
  return `${label} is temporarily unavailable.`;
}

export function formatCoverageAge(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round((seconds / 3_600) * 10) / 10}h`;
}
