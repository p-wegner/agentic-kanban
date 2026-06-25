import { projectStatuses } from "@agentic-kanban/shared/schema";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { createBoardEvents } from "../services/board-events.js";
import type { MonitorActionName } from "../services/monitor-nudge.js";
import { contractCoupledComponent, confirmContractComponent } from "../services/issue-ai.service.js";

/**
 * Gated auto-contract step (#918) — the agentic half's payoff.
 *
 * BEFORE the monitor fans coupled tickets out into separate workspaces (`runAutoStart`),
 * this step finds coupled COMPONENTS (connected `coupled_with` peers, declared at creation
 * via `create_issues_batch` or inferred by the analyzer) and, per a per-project opt-in pref,
 * either CONTRACTS each into one ticket (so the conflicting parallel workspaces never start)
 * or merely SUGGESTS contracting it (logs, leaves the board alone). Off by default.
 *
 * The pref is `auto_contract_coupled_<projectId>`, mirroring the existing per-project auto-*
 * gates (`auto_merge_disabled_<id>`, `start_mode_<id>`):
 *   - `"apply"`            — auto-contract every eligible component this cycle.
 *   - `"suggest"`/`"true"` — log a suggestion per component; make no change.
 *   - absent/`""`/`"false"`/`"off"` — disabled (default).
 *
 * It reuses the SAME primitives as the propose→confirm UI path: `contractCoupledComponent`
 * to discover+propose, `confirmContractComponent` to apply — contract being the documented
 * inverse of `decomposeEpic`. Min component size is `coupling_contract_min_size` (default 2).
 */

export type ContractMode = "off" | "suggest" | "apply";

export function resolveContractMode(value: string | undefined): ContractMode {
  switch ((value ?? "").trim().toLowerCase()) {
    case "apply":
      return "apply";
    case "suggest":
    case "true":
      return "suggest";
    default:
      return "off";
  }
}

const CONTRACT_KEY_RE = /^auto_contract_coupled_([0-9a-f-]+)$/;

/** Project ids whose `auto_contract_coupled_<id>` pref resolves to a non-off mode. */
export function contractModeByProject(prefMap: Map<string, string>): Map<string, ContractMode> {
  const out = new Map<string, ContractMode>();
  for (const [key, value] of prefMap) {
    const m = CONTRACT_KEY_RE.exec(key);
    if (!m) continue;
    const mode = resolveContractMode(value);
    if (mode !== "off") out.set(m[1], mode);
  }
  return out;
}

export interface ContractStepDeps {
  boardEvents: ReturnType<typeof createBoardEvents>;
  logMonitorAction: (action: MonitorActionName, workspaceId: string, issueId: string) => void;
  /** Which projects this cycle may act on (same predicate the rest of the cycle uses). */
  allowProject: (projectId: string) => boolean;
  database?: typeof db;
}

/**
 * Run the gated auto-contract step for every opted-in project. Returns the number of
 * components contracted (apply mode) — 0 when every project is off/suggest. Best-effort:
 * a failure on one component/project is logged and never aborts the monitor cycle.
 */
export async function runAutoContract(
  prefMap: Map<string, string>,
  { boardEvents, logMonitorAction, allowProject, database = db }: ContractStepDeps,
): Promise<number> {
  const modes = contractModeByProject(prefMap);
  if (modes.size === 0) return 0;

  let contracted = 0;
  for (const [projectId, mode] of modes) {
    if (!allowProject(projectId)) continue;
    // Only act on projects that actually exist (have statuses); skip silently otherwise.
    const exists = await database.select({ id: projectStatuses.id }).from(projectStatuses)
      .where(sql`${projectStatuses.projectId} = ${projectId}`).limit(1);
    if (exists.length === 0) continue;

    let proposalsResult;
    try {
      proposalsResult = await contractCoupledComponent(projectId, database);
    } catch (err) {
      console.warn(`[monitor] auto-contract discovery failed for project ${projectId}:`, err instanceof Error ? err.message : err);
      continue;
    }
    const proposals = proposalsResult.proposals;
    if (proposals.length === 0) continue;

    for (const proposal of proposals) {
      const memberNumbers = proposal.members.map((m) => `#${m.issueNumber}`).join(", ");
      if (mode === "suggest") {
        console.log(`[monitor] auto-contract SUGGESTION (project ${projectId}): contract ${proposal.members.length} coupled tickets ${memberNumbers} into #${proposal.members.find((m) => m.id === proposal.survivorId)?.issueNumber}. ${proposal.reason}`);
        logMonitorAction("auto_contract_suggest", "", proposal.survivorId);
        continue;
      }
      // apply
      try {
        await confirmContractComponent(
          {
            projectId,
            survivorId: proposal.survivorId,
            memberIds: proposal.members.map((m) => m.id),
            mergedTitle: proposal.mergedTitle,
            mergedDescription: proposal.mergedDescription,
          },
          database,
        );
        contracted++;
        console.log(`[monitor] auto-contracted coupled tickets ${memberNumbers} into survivor (project ${projectId})`);
        logMonitorAction("auto_contract", "", proposal.survivorId);
        boardEvents.broadcast(projectId, "board_changed");
      } catch (err) {
        // e.g. an open workspace appeared between discovery and apply — leave it for next cycle.
        console.warn(`[monitor] auto-contract apply skipped for ${memberNumbers} (project ${projectId}):`, err instanceof Error ? err.message : err);
      }
    }
  }
  return contracted;
}
