/**
 * One report shape for the board's converging PASSES (#592).
 *
 * A pass is the `run*` / `sweep*` / `reap*` / `reconcile*` family: it scans a candidate
 * set, acts on some of them, deliberately leaves the rest, and says what it did. There are
 * 43 of them across `services/` and `startup/`, and they had ~20 different result
 * interfaces for that one idea — `{checked, closed, released, held}`, `{scanned, reaped,
 * skippedAhead, skippedRunning}`, `{landed, held}`, `{checked, clearedNodes,
 * convergedToDone}`. Every caller, log line and monitor therefore had to learn each pass's
 * private vocabulary, and a pass that reported nothing at all (several return a bare
 * `number`, or `void`) was indistinguishable from one that found nothing.
 *
 * `PassReport` is the COMMON CORE, not a replacement: a pass keeps its own outcome lists
 * and extends this. `interface XSweepResult extends PassReport { closed: string[] }` loses
 * no information — which is the only reason adopting it is safe to do mechanically.
 *
 * Deliberately NOT in `packages/shared`: every pass is server-side, and `shared/lib` is
 * for code more than one package needs (#590).
 */

/** One decision a pass made, with the reason it made it. */
export interface PassOutcome {
  /** Whatever the pass identifies its subjects by — workspace id, branch, project id. */
  id: string;
  /** Why. Short and machine-groupable: log lines and monitors group on this. */
  reason: string;
}

export interface PassReport {
  /** Candidates the pass looked at. */
  scanned: number;
  /** Candidates it changed something for. */
  acted: number;
  /**
   * Candidates it deliberately left alone. `acted + skipped` may be LESS than `scanned` —
   * a candidate that threw is neither, and pretending otherwise is how a pass reports a
   * clean run while silently swallowing failures.
   */
  skipped: number;
  /** Per-candidate reasons, in the order the pass decided them. */
  reasons: PassOutcome[];
}

export function emptyPassReport(scanned = 0): PassReport {
  return { scanned, acted: 0, skipped: 0, reasons: [] };
}

/** Record that the pass CHANGED something for `id`. */
export function recordActed(report: PassReport, id: string, reason: string): void {
  report.acted += 1;
  report.reasons.push({ id, reason });
}

/** Record that the pass deliberately left `id` alone. */
export function recordSkipped(report: PassReport, id: string, reason: string): void {
  report.skipped += 1;
  report.reasons.push({ id, reason });
}

/**
 * The pass summary WITHOUT a `[tag]` prefix, for a sweep that logs through an injected
 * `log` (#616 — the injected logger already applies the file's tag, so `formatPassReport`
 * there would double it). Names the unaccounted-for remainder explicitly rather than
 * letting it vanish — `scanned 9, acted 2, skipped 5` silently hides 2 failures.
 */
export function formatPassReportBody(report: PassReport): string {
  const unaccounted = report.scanned - report.acted - report.skipped;
  const tail = unaccounted > 0 ? `, ${unaccounted} unaccounted` : "";
  return `scanned ${report.scanned}, acted ${report.acted}, skipped ${report.skipped}${tail}`;
}

/**
 * One log line for a pass, tagged. For a sweep with no injected logger; a sweep that HAS
 * one passes `formatPassReportBody` to it instead.
 */
export function formatPassReport(name: string, report: PassReport): string {
  return `[${name}] ${formatPassReportBody(report)}`;
}

/** Reasons grouped by reason string — what a monitor or digest actually wants. */
export function passReasonCounts(report: PassReport): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of report.reasons) {
    counts[outcome.reason] = (counts[outcome.reason] ?? 0) + 1;
  }
  return counts;
}
