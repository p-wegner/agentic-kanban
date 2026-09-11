import { computeBlockerReadiness, isTerminalStatusIdView, type BlockerWorkspaceLanding } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import {
  selectBlockerIds,
  selectBlockerStates,
  selectBlockerWorkspaceLandings,
} from "../repositories/auto-start.repository.js";

/**
 * The dependency gate for a project's pull loop: a blocker unblocks only when terminal AND
 * landed (#535/#537/#782/#784). Built once per project cycle so the lead candidate and the
 * group-member vetting share one implementation.
 *
 * Moved out of `startup/monitor-todo-pull.ts` by #1102 so `GET /api/projects/:id/autopilot`
 * counts "ready tickets" with the SAME gate the monitor starts them with — a route cannot
 * import `startup/`.
 */
export function buildDependencyGate(doneStatusIds: Set<string>, database: Database): (issueId: string) => Promise<boolean> {
  return async (issueId: string): Promise<boolean> => {
    const blockerIds = await selectBlockerIds(issueId, database);
    if (blockerIds.length === 0) return true;
    const blockerIssues = await selectBlockerStates(blockerIds, database);
    if (blockerIssues.length !== blockerIds.length) return false;
    const blockerWorkspaces = await selectBlockerWorkspaceLandings(blockerIds, database);
    const wsByBlocker = new Map<string, BlockerWorkspaceLanding[]>();
    for (const w of blockerWorkspaces) {
      const list = wsByBlocker.get(w.issueId) ?? [];
      list.push({ mergedAt: w.mergedAt, isDirect: w.isDirect });
      wsByBlocker.set(w.issueId, list);
    }
    return blockerIssues.every((b) => computeBlockerReadiness({
      isTerminal: isTerminalStatusIdView(b, doneStatusIds),
      workspaces: wsByBlocker.get(b.id) ?? [],
    }));
  };
}
