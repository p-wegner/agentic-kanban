// Shared types + constants for the timeScale model (#1088/#1090). Split out of the former
// monolithic timeScale.ts (#889 god-module gate) so each sub-module can depend on the
// contracts without depending on each other's implementations.

export type Scale = "day" | "week" | "month" | "quarter";

export interface Viewport {
  scale: Scale;
  /** Left edge of the visible window before snapping, ms epoch (local time). */
  anchor: number;
  /** Zoom level: horizontal pixels per millisecond. */
  pxPerMs: number;
}

export interface TimeWindow {
  min: number;
  max: number;
}

export interface Tick {
  ts: number;
  label: string;
}

/** Two-band axis: `major` carries the labelled boundaries, `minor` the finer gridlines. */
export interface TickBands {
  major: Tick[];
  minor: Tick[];
}

export interface ClippedSpan {
  x: number;
  width: number;
  clippedStart: boolean;
  clippedEnd: boolean;
}

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
