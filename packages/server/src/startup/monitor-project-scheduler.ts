// #416: cross-cycle project scheduling for the monitor's candidate walk.
//
// MEASURED problem: with 10 monitor-driven projects one cycle's candidate walk alone ran
// ~3 minutes (184s of a 213s cycle), i.e. >= the 4-min interval — so `cycleInFlight` was
// effectively always true and the event loop never had an idle moment (/api/health p50
// 1.86s, 68% of samples >1s). Per-PROJECT budgets (#208) bound one project's walk, but the
// AGGREGATE across all projects still exceeded the interval, and every cycle restarted at
// project #1 — re-paying the full fan-out each time.
//
// This module holds the two pieces of cross-cycle state that fix that, IN MEMORY (a restart
// simply starts over — that is deliberate; none of this is correctness state):
//
//   1. **Carry-over cursor** — when a cycle's global wall-clock budget stops it before every
//      project's sub-pass ran, the NEXT cycle's plan is rotated to start at the first project
//      that did not complete, so all projects are covered within N cycles instead of every
//      cycle doing (a prefix of) all of them.
//   2. **Per-project activity tracking** — a project with NO board activity since its last
//      COMPLETED sub-pass is skipped entirely (its walk would find nothing to do), with a
//      slow safety-net floor (~15 min) that forces a pass anyway to catch external mutations
//      (a hand-merged branch, git changes outside the board's own event stream).
//
// The per-project SEMANTICS of a sub-pass are untouched — this schedules which projects a
// cycle walks, never what the walk does.

/** Safety-net floor: a skipped-inactive project still gets a sub-pass at least this often. */
export const DEFAULT_MONITOR_PROJECT_SLOW_FLOOR_MS = 15 * 60_000;

export interface MonitorCyclePlan {
  /** Project ids to walk this cycle, in walk order (cursor project first). */
  toRun: string[];
  /** Project ids skipped as inactive (no activity since last completed sub-pass, floor not due). */
  skipped: string[];
}

export interface MonitorProjectScheduler {
  /** Bump a project's activity clock (board events: merges, session exits, ticket mutations). */
  recordActivity(projectId: string): void;
  /** Plan which of `projectIds` this cycle should walk, rotated to resume at the cursor. */
  planCycle(projectIds: string[]): MonitorCyclePlan;
  /**
   * Record the cycle's outcome: `completed` sub-passes stamp the project's completion clock
   * (consuming activity that predates the stamp — including the walk's OWN broadcasts, so the
   * monitor's actions do not perpetually mark every project active); planned-but-not-completed
   * projects (budget-stopped or #208-deferred) become the resume set, and the FIRST of them in
   * plan order becomes the next cycle's cursor.
   */
  recordCycleResult(result: { planned: string[]; completed: string[] }): void;
}

export function createMonitorProjectScheduler(options?: {
  /** Clock seam for deterministic tests. */
  now?: () => number;
  slowFloorMs?: number;
}): MonitorProjectScheduler {
  const now = options?.now ?? Date.now;
  const slowFloorMs = options?.slowFloorMs ?? DEFAULT_MONITOR_PROJECT_SLOW_FLOOR_MS;

  const activityAt = new Map<string, number>();
  const completedAt = new Map<string, number>();
  /** Planned last cycle but not completed — must run next cycle regardless of activity. */
  const pendingResume = new Set<string>();
  let cursorProjectId: string | null = null;

  function recordActivity(projectId: string): void {
    activityAt.set(projectId, now());
  }

  function isDue(projectId: string): boolean {
    if (pendingResume.has(projectId)) return true;
    const done = completedAt.get(projectId);
    if (done === undefined) return true; // never completed a sub-pass (startup, new project)
    const activity = activityAt.get(projectId);
    if (activity !== undefined && activity > done) return true; // activity since last sub-pass
    return now() - done >= slowFloorMs; // slow safety-net floor
  }

  function planCycle(projectIds: string[]): MonitorCyclePlan {
    // Rotate so the cursor project goes FIRST: a budget-stopped cycle's tail is the next
    // cycle's head, which is what makes coverage of all projects converge across cycles.
    const ordered = [...projectIds];
    if (cursorProjectId !== null) {
      const idx = ordered.indexOf(cursorProjectId);
      if (idx > 0) ordered.push(...ordered.splice(0, idx));
    }
    const toRun: string[] = [];
    const skipped: string[] = [];
    for (const id of ordered) (isDue(id) ? toRun : skipped).push(id);
    return { toRun, skipped };
  }

  function recordCycleResult(result: { planned: string[]; completed: string[] }): void {
    const completed = new Set(result.completed);
    const at = now();
    cursorProjectId = null;
    for (const id of result.planned) {
      if (completed.has(id)) {
        completedAt.set(id, at);
        pendingResume.delete(id);
      } else {
        pendingResume.add(id);
        if (cursorProjectId === null) cursorProjectId = id;
      }
    }
  }

  return { recordActivity, planCycle, recordCycleResult };
}
