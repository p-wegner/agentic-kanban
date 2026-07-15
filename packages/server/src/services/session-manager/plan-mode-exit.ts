import * as lifecycleRepo from "../../repositories/session-lifecycle.repository.js";
import type { Database } from "../../db/index.js";
import { writePlanFile, buildImplementPrompt } from "../plan-mode.service.js";
import { getHarnessBoolSetting } from "../harness-settings.js";
import { emitButlerSystemEvent } from "../butler-event-feed.js";
import type { ProviderName } from "../agent-provider.js";
import type { ProviderId } from "../agent-provider.js";
import type { StartSessionOptions } from "./types.js";

export interface PlanModeExitRelaunch {
  agentCommand: string | undefined;
  agentArgs: string | undefined;
  claudeProfile: string | undefined;
  permissionPromptTool: string | undefined;
  provider: ProviderId | undefined;
  profile: { provider: ProviderName; name: string } | undefined;
}

export interface FinalizePlanModeExitDeps {
  db: Database;
  workspaceWorkingDir: string | null | undefined;
  projectId: string;
  /** Relaunches a new session (the outer startSession closure) — injected to keep this module standalone. */
  startSession: (opts: StartSessionOptions) => Promise<string>;
}

/**
 * Plan-mode completion (#924). Always clears planMode and lands the workspace in a
 * VISIBLE state — never a silent idle In Progress with planMode stuck true. Extracted
 * so the "no plan captured / non-zero exit" recovery path is explicit and testable.
 */
export async function finalizePlanModeExit(
  workspaceId: string,
  exitCode: number | null,
  planText: string | null,
  relaunch: PlanModeExitRelaunch,
  deps: FinalizePlanModeExitDeps,
): Promise<void> {
  const { db, workspaceWorkingDir, projectId, startSession } = deps;
  try {
    // `planText` is already the strict marker-block (or null) from the raw-buffer scan;
    // a non-zero exit invalidates it (a crashed run can't have produced a real plan).
    const plan = exitCode === 0 ? planText : null;
    const nowIso = () => new Date().toISOString();

    // No usable plan (empty text, extract failed, or non-zero exit): clear plan mode
    // and surface a needs-attention state instead of stranding the workspace. A normal
    // follow-up turn then implements (never re-runs read-only — planMode is now false).
    if (!plan || !workspaceWorkingDir) {
      await lifecycleRepo.updateWorkspacePlanMode(workspaceId, false, nowIso(), db);
      await lifecycleRepo.updateWorkspaceStatusOnly(workspaceId, "blocked", nowIso(), db);
      const reason = exitCode !== 0
        ? `plan run exited with code ${exitCode}`
        : "plan run produced no plan text";
      console.warn(`[session] plan-mode run produced no usable plan (${reason}): workspaceId=${workspaceId} — cleared planMode, marked blocked`);
      if (projectId) {
        emitButlerSystemEvent({
          projectId,
          kind: "session_failed",
          workspaceId,
          text: `Plan-mode run for workspace ${workspaceId} produced no usable plan (${reason}). Cleared plan mode and marked the workspace blocked — a normal turn will now implement.`,
        });
      }
      return;
    }

    const planPath = writePlanFile(workspaceWorkingDir, plan);
    await lifecycleRepo.updateWorkspacePlanMode(workspaceId, false, nowIso(), db);

    const harness = relaunch.provider === "codex" ? "codex" : relaunch.provider === "copilot" ? "copilot" : "claude";
    const prefRows = await lifecycleRepo.getAllPreferences(db);
    const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));
    const autoContinue = getHarnessBoolSetting(prefMap, harness, "plan_auto_continue");

    if (autoContinue) {
      console.log(`[session] plan ready (${planPath}) — auto-continuing to implementation: workspaceId=${workspaceId}`);
      await lifecycleRepo.updateWorkspaceStatusOnly(workspaceId, "active", nowIso(), db);
      await startSession({
        workspaceId,
        prompt: buildImplementPrompt(),
        agentCommand: relaunch.agentCommand,
        agentArgs: relaunch.agentArgs,
        claudeProfile: relaunch.claudeProfile,
        permissionPromptTool: relaunch.permissionPromptTool,
        planMode: false,
        provider: relaunch.provider,
        triggerType: "plan-implement",
        profile: relaunch.profile,
      });
    } else {
      console.log(`[session] plan ready (${planPath}) — awaiting human approval: workspaceId=${workspaceId}`);
      await lifecycleRepo.updateWorkspacePendingPlan(workspaceId, planPath, "awaiting-plan-approval", nowIso(), db);
    }
  } catch (err) {
    console.error(`[session] plan completion handling failed: workspaceId=${workspaceId}`, err);
  }
}
