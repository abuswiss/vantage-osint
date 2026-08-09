/**
 * Truth gap: a USNI report whose region string could not be mapped to any
 * named region used to get a string-hash lat/lon — an arbitrary fabricated
 * point anywhere on the globe. Such reports must NOT become map vessels at
 * all (the full report stays in intelligenceCache.usniFleet as region-level
 * evidence); defensible locations (parsed report coords, named-ocean
 * approximations, resolved homeports) still render, marked approximate.
 */
import { describe, expect, it } from 'vitest';

import { mergeUSNIWithAIS } from '@/services/usni-fleet';
import { getUSNIRegionApproxCoords } from '@/config/military';
import type { USNIFleetReport, USNIVesselEntry } from '@/types';

function usniEntry(overrides: Partial<USNIVesselEntry> = {}): USNIVesselEntry {
  return {
    name: 'USS Example',
    hullNumber: 'DDG-1000',
    vesselType: 'destroyer',
    region: 'Undisclosed Waters Alpha',
    regionLat: 0,
    regionLon: 0,
    deploymentStatus: 'deployed',
    usniArticleUrl: 'https://news.usni.org/example',
    usniArticleDate: '2026-08-03',
    ...overrides,
  } as USNIVesselEntry;
}

function report(vessels: USNIVesselEntry[]): USNIFleetReport {
  return {
    articleUrl: 'https://news.usni.org/example',
    articleDate: '2026-08-03',
    articleTitle: 'USNI Fleet Tracker',
    vessels,
    strikeGroups: [],
    regions: [],
    parsingWarnings: [],
    timestamp: '2026-08-03T00:00:00.000Z',
  };
}

describe('USNI unmappable reports never fabricate a map point', () => {
  it('getUSNIRegionApproxCoords returns undefined for unknown regions instead of a hash point', () => {
    expect(getUSNIRegionApproxCoords('Undisclosed Waters Alpha')).toBeUndefined();
    // Named oceans remain defensible approximations.
    expect(getUSNIRegionApproxCoords('Western Pacific Ocean')).toBeDefined();
  });

  it('drops the map vessel when no defensible location exists, keeps defensible ones', () => {
    const { vessels } = mergeUSNIWithAIS([], report([
      usniEntry({ name: 'USS Unlocated', hullNumber: 'DDG-9001' }),
      usniEntry({ name: 'USS Parsed', hullNumber: 'DDG-9002', regionLat: 12, regionLon: 45 }),
      usniEntry({ name: 'USS Ocean', hullNumber: 'DDG-9003', region: 'Atlantic Ocean' }),
    ]));

    const names = vessels.map((v) => v.name);
    expect(names).not.toContain('USS Unlocated');
    expect(names).toContain('USS Parsed');
    expect(names).toContain('USS Ocean');

    const parsed = vessels.find((v) => v.name === 'USS Parsed')!;
    // Parsed report coords ± the deterministic scatter (< 0.5 deg).
    expect(Math.abs(parsed.lat - 12)).toBeLessThan(0.6);
    expect(Math.abs(parsed.lon - 45)).toBeLessThan(0.6);
    expect(vessels.every((v) => v.usniSource === true)).toBe(true);
  });

  it('cluster counts only include locatable vessels', () => {
    const { clusters } = mergeUSNIWithAIS([], report([
      usniEntry({ name: 'USS Unlocated A', hullNumber: 'DDG-9001', strikeGroup: 'Ghost CSG' }),
      usniEntry({ name: 'USS Unlocated B', hullNumber: 'DDG-9002', strikeGroup: 'Ghost CSG' }),
    ]));
    // Two reports, zero defensible positions: no cluster may be drawn.
    expect(clusters.filter((c) => c.id.startsWith('usni-cluster-')).length).toBe(0);
  });
});
