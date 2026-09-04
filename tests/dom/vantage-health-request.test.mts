import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchVantageHealth, parseVantageHealth } from '@/services/vantage-health';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('coverage request recovery', () => {
  it('bounds a stalled request and cancels the underlying fetch', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      requestSignal = options.signal;
      requestSignal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const result = fetchVantageHealth();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await result).toBeNull();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('does not start work after its caller has cancelled', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await fetchVantageHealth(AbortSignal.abort())).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns unavailable for a non-JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('export default handler')));
    expect(await fetchVantageHealth()).toBeNull();
  });

  it('rejects an invalid checked-at timestamp', () => {
    expect(parseVantageHealth({
      status: 'ready', checkedAt: 'not a date',
      services: {
        redis: 'ready', news: { status: 'ready' }, insights: { status: 'ready' }, risk: { status: 'ready' },
        relay: { status: 'ready', air: 'ready', ships: 'ready' },
      },
    })).toBeNull();
  });
});
