import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_MAP_LAYERS } from '../src/config/panels';
import {
  MILITARY_DETAIL_MIN_ZOOM,
  shouldShowMilitaryClusters,
  shouldShowMilitaryDetail,
} from '../src/utils/map-detail-visibility';

describe('map military progressive disclosure', () => {
  it('starts the web map without dense asset layers', () => {
    assert.equal(DEFAULT_MAP_LAYERS.bases, false);
    assert.equal(DEFAULT_MAP_LAYERS.military, false);
  });

  it('shows aggregates globally and swaps to individual assets at regional zoom', () => {
    assert.equal(MILITARY_DETAIL_MIN_ZOOM, 3);
    assert.equal(shouldShowMilitaryClusters(1.5), true);
    assert.equal(shouldShowMilitaryDetail(1.5), false);
    assert.equal(shouldShowMilitaryClusters(2.99), true);
    assert.equal(shouldShowMilitaryDetail(3), true);
    assert.equal(shouldShowMilitaryClusters(3), false);
  });

  it('fails closed to aggregate mode for an invalid zoom', () => {
    assert.equal(shouldShowMilitaryDetail(Number.NaN), false);
    assert.equal(shouldShowMilitaryClusters(Number.NaN), true);
  });
});
