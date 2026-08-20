import { isAutodriveStallWarning, type MonitorWarning } from "./monitor-popover.js";

/**
 * Which monitor warnings belong on THIS board's toolbar, and what the button should say
 * about them (#637).
 *
 * The monitor status is global — it reports warnings for every project the board watches.
 * The toolbar button rendered them all, so a board could sit there red with a warning
 * triangle for a problem in a completely different project, one the user cannot act on
 * from the board they are looking at and often cannot even see. A red alert on a board
 * has to mean that board. The POPOVER still lists every project's warnings (each already
 * badged with its project name) — the scoping is about what the button claims, not about
 * hiding information.
 *
 * The tooltip was a hardcoded literal ("dirty main checkout") shown for any warning at
 * all, so an autodrive stall — which the popover renders as a different warning entirely —
 * described itself as a dirty checkout. It is derived from the warnings now.
 */

/** Warnings raised against `projectId`. No project selected ⇒ none are this board's. */
export function warningsForProject(
  warnings: MonitorWarning[] | undefined,
  projectId: string | null | undefined,
): MonitorWarning[] {
  if (!warnings?.length || !projectId) return [];
  return warnings.filter((w) => w.projectId === projectId);
}

/** Short human label for one warning, matching the wording the popover uses. */
function warningLabel(warning: MonitorWarning): string {
  return isAutodriveStallWarning(warning) ? "autodrive stalled" : "dirty main checkout";
}

/**
 * Tooltip for the monitor button, given the warnings that are actually this board's.
 * Returns null when there are none, so the caller falls back to its normal title.
 */
export function describeMonitorWarnings(warnings: MonitorWarning[]): string | null {
  if (warnings.length === 0) return null;
  // Distinct causes, in first-seen order: three dirty-checkout warnings should read as
  // one cause, not a list of three identical phrases.
  const causes: string[] = [];
  for (const w of warnings) {
    const label = warningLabel(w);
    if (!causes.includes(label)) causes.push(label);
  }
  const prefix = warnings.length === 1 ? "Board monitor warning" : `Board monitor: ${warnings.length} warnings`;
  return `${prefix} — ${causes.join(", ")}`;
}
