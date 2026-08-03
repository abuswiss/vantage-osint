// Single-variant build: this fork ships only the geopolitical ('full') variant.
// The upstream multi-variant system (tech/finance/happy/commodity/energy) was
// removed; SITE_VARIANT stays a plain string so downstream comparisons keep
// compiling while the remaining variant branches are cleaned up.
export const SITE_VARIANT: string = 'full';
