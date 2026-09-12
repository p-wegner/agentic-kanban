/**
 * Project QUIESCE (#1108) — a maintenance-window hold, distinct from Start Mode.
 *
 * `start_mode=manual` was measured to NOT stop a relaunch: its own docstring says "only
 * explicit user/agent actions (POST /api/workspaces, relaunch) create workspaces", and a
 * relaunch is exactly what an operator hit while promoting master — the monitor (or a
 * reconciler) relaunched a stopped/no-auto-start-tagged workspace ~20s after it was
 * stopped. Quiesce closes that gap by being enforced at the two chokepoints every
 * workspace-creating/agent-launching path funnels through — `createWorkspace` and
 * `launchSession` — rather than at the monitor's own auto-start decision, which a
 * relaunch, a cron, or the external Conductor loop never consult in the first place.
 *
 * `prefMap` resolver (pure, synchronous) per the `startup/`+`services/` naming
 * convention — see packages/server/CLAUDE.md's "Named kinds" table.
 */
import { getBool } from "@agentic-kanban/shared/lib/settings-registry";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { WorkspaceError } from "./workspace-error.js";
import type { Database } from "../db/index.js";

const quiescedPrefDef = projectPref("project_quiesced");
const quiesceReasonPrefDef = projectPref("project_quiesce_reason");

export function projectQuiescedPrefKey(projectId: string): string {
  return quiescedPrefDef.key(projectId);
}

export function projectQuiesceReasonPrefKey(projectId: string): string {
  return quiesceReasonPrefDef.key(projectId);
}

/** Is this project currently held for maintenance? */
export function isProjectQuiesced(prefMap: Map<string, string>, projectId: string): boolean {
  return getBool(prefMap, projectQuiescedPrefKey(projectId));
}

/** The operator-supplied reason, if any, for a project's current quiesce. */
export function getQuiesceReason(prefMap: Map<string, string>, projectId: string): string | undefined {
  const raw = prefMap.get(projectQuiesceReasonPrefKey(projectId));
  return raw && raw.trim() ? raw : undefined;
}

/** The refusal message every quiesce-gated chokepoint raises, worded for its caller. */
export function quiesceRefusalMessage(projectId: string, reason: string | undefined, action: string): string {
  const reasonSuffix = reason ? `: ${reason}` : "";
  return (
    `This project is quiesced for maintenance${reasonSuffix} — ${action} is held until the ` +
    `operator clears \`project_quiesced_${projectId}\`.`
  );
}

/**
 * The one-line call every chokepoint (`createWorkspace`, `launchSession`) makes. Throws a
 * `WorkspaceError("CONFLICT", { code: "PROJECT_QUIESCED" })` when the project is held;
 * no-ops for a null projectId (a workspace whose project could not be resolved has bigger
 * problems than quiesce).
 */
export async function assertProjectNotQuiesced(
  database: Database,
  projectId: string | null,
  action: string,
): Promise<void> {
  if (!projectId) return;
  const prefMap = toPrefMap(await getAllPreferencesCached(database));
  if (!isProjectQuiesced(prefMap, projectId)) return;
  throw new WorkspaceError(
    quiesceRefusalMessage(projectId, getQuiesceReason(prefMap, projectId), action),
    "CONFLICT",
    { code: "PROJECT_QUIESCED", projectId },
  );
}
