// Zoom-density model for the timeScale scale (#1088/#1090): target px/day per scale, the
// range before crossing to a neighbouring scale, and the neighbour lookup itself. Split out
// of the former monolithic timeScale.ts (#889 god-module gate); consumed by viewport.ts for
// zoomAround's scale-crossing logic.

import type { Scale } from "./types";
import { DAY_MS } from "./types";

/** Coarse → fine. Index order is what `zoomAround` walks when crossing a density threshold. */
const SCALE_ORDER: readonly Scale[] = ["quarter", "month", "week", "day"];

/** Target zoom density (px/day) per scale, and the range before crossing to a neighbour. */
const SCALE_PX_PER_DAY: Record<Scale, { min: number; default: number; max: number }> = {
  quarter: { min: 1, default: 3, max: 6 },
  month: { min: 6, default: 10, max: 20 },
  week: { min: 20, default: 40, max: 80 },
  day: { min: 80, default: 120, max: 400 },
};

function pxPerMsFromPxPerDay(pxPerDay: number): number {
  return pxPerDay / DAY_MS;
}

export function defaultPxPerMs(scale: Scale): number {
  return pxPerMsFromPxPerDay(SCALE_PX_PER_DAY[scale].default);
}

export function pxPerMsRangeFor(scale: Scale): { min: number; max: number } {
  const { min, max } = SCALE_PX_PER_DAY[scale];
  return { min: pxPerMsFromPxPerDay(min), max: pxPerMsFromPxPerDay(max) };
}

export function finerScale(scale: Scale): Scale | null {
  const i = SCALE_ORDER.indexOf(scale);
  return i < SCALE_ORDER.length - 1 ? SCALE_ORDER[i + 1] : null;
}

export function coarserScale(scale: Scale): Scale | null {
  const i = SCALE_ORDER.indexOf(scale);
  return i > 0 ? SCALE_ORDER[i - 1] : null;
}

export function scaleForSpan(spanMs: number): Scale {
  const days = spanMs / DAY_MS;
  if (days <= 10) return "day";
  if (days <= 60) return "week";
  if (days <= 400) return "month";
  return "quarter";
}
