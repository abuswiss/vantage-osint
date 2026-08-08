import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveStoryThreat } from '../scripts/seed-insights.mjs';

describe('seed-insights threat integrity', () => {
  it('preserves keyword-classified threat semantics instead of re-keywording the title', () => {
    const story = {
      primaryTitle: 'Travelling through Iran during the war: what visitors should know',
      threat: { level: 'high', category: 'conflict', source: 'keyword' },
    };

    assert.deepEqual(resolveStoryThreat(story), { category: 'conflict', threatLevel: 'high' });
  });

  it('preserves historical downgrades even when the title contains critical keywords', () => {
    const story = {
      primaryTitle: 'How the missile war changed the region twenty years ago',
      threat: { level: 'info', category: 'history', source: 'keyword-historical-downgrade' },
    };

    assert.deepEqual(resolveStoryThreat(story), { category: 'history', threatLevel: 'info' });
  });

  it('preserves valid LLM classifications and retains the legacy fallback for incomplete payloads', () => {
    assert.deepEqual(resolveStoryThreat({
      primaryTitle: 'Regional talks continue',
      threat: { level: 'medium', category: 'geopolitical', source: 'llm' },
    }), { category: 'geopolitical', threatLevel: 'medium' });

    assert.deepEqual(resolveStoryThreat({
      primaryTitle: 'Missile attack hits military base',
    }), { category: 'conflict', threatLevel: 'critical' });
  });
});
