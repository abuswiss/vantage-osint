/**
 * OpsShell missions are a strict subset of the classic mission presets — one
 * definition drives both shells, so a mission always means the same
 * layers/view/time context wherever it is applied. Pins that each ops mission
 * resolves to a real preset with a coherent, non-empty map context.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MISSION_PRESETS,
  OPS_MISSION_PRESET_IDS,
} from '../src/services/mission-presets.ts';

describe('OpsShell mission subset', () => {
  it('keeps a small, focused set (3 outcomes, not 5 personas)', () => {
    assert.equal(OPS_MISSION_PRESET_IDS.length, 3);
    assert.equal(new Set(OPS_MISSION_PRESET_IDS).size, OPS_MISSION_PRESET_IDS.length);
  });

  it('every ops mission resolves to a defined preset with a coherent context', () => {
    for (const id of OPS_MISSION_PRESET_IDS) {
      const preset = MISSION_PRESETS.find((candidate) => candidate.id === id);
      assert.ok(preset, `ops mission '${id}' must exist in MISSION_PRESETS`);
      assert.ok(preset.layers.length > 0, `ops mission '${id}' must set map layers`);
      assert.ok(preset.view, `ops mission '${id}' must set a map view`);
      assert.ok(preset.timeRange, `ops mission '${id}' must set a time range`);
      assert.ok(preset.label && preset.shortLabel && preset.description, `ops mission '${id}' must carry display copy`);
    }
  });
});
