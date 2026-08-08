import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getStrategicRiskDisplayBand,
  getStrategicRiskDisplayLevel,
} from '../src/utils/strategic-risk-band';

describe('strategic risk display bands', () => {
  it('uses one canonical vocabulary at every threshold', () => {
    assert.equal(getStrategicRiskDisplayLevel(0), 'low');
    assert.equal(getStrategicRiskDisplayLevel(31), 'normal');
    assert.equal(getStrategicRiskDisplayLevel(57), 'elevated');
    assert.equal(getStrategicRiskDisplayLevel(66), 'high');
    assert.equal(getStrategicRiskDisplayLevel(81), 'critical');
  });

  it('fails closed to the low band for non-finite input', () => {
    assert.deepEqual(getStrategicRiskDisplayBand(Number.NaN), {
      min: 0,
      levelKey: 'low',
      colorVar: '--semantic-low',
    });
  });
});
