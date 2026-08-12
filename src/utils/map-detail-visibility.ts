/**
 * Keep the global picture legible: aggregate moving military assets until the
 * operator zooms into a regional view, then replace aggregates with detail.
 */
export const MILITARY_DETAIL_MIN_ZOOM = 3;

export function shouldShowMilitaryDetail(zoom: number): boolean {
  return Number.isFinite(zoom) && zoom >= MILITARY_DETAIL_MIN_ZOOM;
}

export function shouldShowMilitaryClusters(zoom: number): boolean {
  return !shouldShowMilitaryDetail(zoom);
}
