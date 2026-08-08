export type StrategicRiskDisplayLevel = 'critical' | 'high' | 'elevated' | 'normal' | 'low';

export interface StrategicRiskDisplayBand {
  min: number;
  levelKey: StrategicRiskDisplayLevel;
  colorVar: string;
}

const STRATEGIC_RISK_BANDS: readonly StrategicRiskDisplayBand[] = [
  { min: 81, levelKey: 'critical', colorVar: '--semantic-critical' },
  { min: 66, levelKey: 'high', colorVar: '--semantic-high' },
  { min: 51, levelKey: 'elevated', colorVar: '--semantic-elevated' },
  { min: 31, levelKey: 'normal', colorVar: '--semantic-normal' },
  { min: 0, levelKey: 'low', colorVar: '--semantic-low' },
] as const;

export function getStrategicRiskDisplayBand(score: number): StrategicRiskDisplayBand {
  const bounded = Number.isFinite(score) ? score : 0;
  return STRATEGIC_RISK_BANDS.find((band) => bounded >= band.min)
    ?? STRATEGIC_RISK_BANDS[STRATEGIC_RISK_BANDS.length - 1]!;
}

export function getStrategicRiskDisplayLevel(score: number): StrategicRiskDisplayLevel {
  return getStrategicRiskDisplayBand(score).levelKey;
}
