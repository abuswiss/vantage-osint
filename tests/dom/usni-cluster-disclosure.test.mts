/**
 * Regression: USNI-derived vessel clusters averaged synthetic positions into a
 * centroid but dropped every provenance marker, so cluster tooltips/popups
 * presented an estimated naval group position as if it were tracked. The
 * cluster must carry `approximate: true` (its members already carry
 * `usniSource`) so all renderers disclose EST. POSITION.
 */
import { describe, expect, it } from 'vitest';

import { mergeUSNIWithAIS } from '@/services/usni-fleet';
import type { USNIFleetReport, USNIVesselEntry } from '@/types';

function usniEntry(overrides: Partial<USNIVesselEntry> = {}): USNIVesselEntry {
  return {
    name: 'USS Example',
    hullNumber: 'DDG-1000',
    vesselType: 'destroyer',
    region: 'Eastern Mediterranean',
    regionLat: 34,
    regionLon: 30,
    deploymentStatus: 'deployed',
    strikeGroup: 'Example CSG',
    usniArticleUrl: 'https://news.usni.org/example',
    usniArticleDate: '2026-08-03',
    ...overrides,
  } as USNIVesselEntry;
}

const report: USNIFleetReport = {
  articleUrl: 'https://news.usni.org/example',
  articleDate: '2026-08-03',
  articleTitle: 'USNI Fleet Tracker',
  vessels: [
    usniEntry({ name: 'USS Alpha', hullNumber: 'DDG-1001' }),
    usniEntry({ name: 'USS Bravo', hullNumber: 'DDG-1002' }),
  ],
  strikeGroups: [],
  regions: ['Eastern Mediterranean'],
  parsingWarnings: [],
  timestamp: '2026-08-03T00:00:00.000Z',
};

describe('USNI cluster provenance', () => {
  it('marks synthetic vessels and their clusters as approximate', () => {
    const { vessels, clusters } = mergeUSNIWithAIS([], report);

    expect(vessels.length).toBe(2);
    expect(vessels.every((v) => v.usniSource === true)).toBe(true);

    const usniClusters = clusters.filter((c) => c.id.startsWith('usni-cluster-'));
    expect(usniClusters.length).toBeGreaterThan(0);
    expect(usniClusters.every((c) => c.approximate === true)).toBe(true);
  });
});
