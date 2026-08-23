import * as lifecycleRepo from "../../repositories/session-lifecycle.repository.js";
import type { Database } from "../../db/index.js";
import { writePlanFile, buildImplementPrompt } from "../plan-mode.service.js";
import { getHarnessBoolSetting } from "../harness-settings.js";
import { emitButlerSystemEvent } from "../butler-event-feed.js";
import { narrowProviderName } from "../agent-provider.js";
import type { ProviderName, ProviderId } from "../agent-provider.js";
import type { StartSessionOptions } from "./types.js";

import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
export interface PlanModeExitRelaunch {
  agentCommand: string | undefined;
  agentArgs: string | undefined;
  permissionPromptTool: string | undefined;
  /**
   * The LAUNCH id, not the stored name (#835). A workspace row stores a
   * `ProviderName` ("claude"); a launch takes a `ProviderId` ("claude-code"),
   * and `toExecutorProvider` is the single conversion between the two. Both
   * callers already supply a `ProviderId` — `session-lifecycle` forwards
   * `StartSessionOptions.provider`, and `plan-mode-reconciler` converts the
   * stored value with `toExecutorProvider(narrowProviderName(...))` — so this
   * is deliberately narrower than the column, and widening it would erase the
   * distinction rather than fix anything. (`narrowProviderName` below maps it
   * back, and accepts the "claude" spelling too, which is what made it look
   * like the declaration was too tight.)
   */
  provider: ProviderId | undefined;
  profile: { provider: ProviderName; name: string } | undefined;
}

export interface FinalizePlanModeExitDeps {
  db: Database;
  workspaceWorkingDir: string | null | undefined;
  projectId: string;
  /** Relaunches a new session (the outer startSession closure) — injected to keep this module standalone. */
  startSession: (opts: StartSessionOptions) => Promise<string>;
  /**
   * #544: the startup reconciler broadcasts board events that the live exit path does
   * not (it runs before any client is watching). Optional, so the live path is unchanged.
   */
  broadcast?: (projectId: string, event: "workflow_error" | "issue_updated") => void;
  /**
   * #544: console tag, per the one-tag-per-subsystem convention. The live path is
   * `[session]`; the reconciler is `[reconcile]`, and a 1600-line log stays greppable
   * per subsystem only if that survives the two paths sharing an implementation.
   */
  logTag?: string;
  /** Human-facing subject for logs/butler text, e.g. `workspace <id> (#42)`. */
  subject?: string;
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
  const { db, workspaceWorkingDir, projectId, startSession, broadcast } = deps;
  const tag = deps.logTag ?? "session";
  const subject = deps.subject ?? `workspace ${workspaceId}`;
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
      console.warn(`[${tag}] plan-mode run produced no usable plan (${reason}): ${subject} — cleared planMode, marked blocked`);
      if (projectId) {
        broadcast?.(projectId, "workflow_error");
        emitButlerSystemEvent({
          projectId,
          kind: "session_failed",
          workspaceId,
          text: `Plan-mode run for ${subject} produced no usable plan (${reason}). Cleared plan mode and marked the workspace blocked — a normal turn will now implement.`,
        });
      }
      return;
    }

    const planPath = writePlanFile(workspaceWorkingDir, plan);
    await lifecycleRepo.updateWorkspacePlanMode(workspaceId, false, nowIso(), db);

    // #544: was a hand-rolled codex/copilot/else ladder that mapped `pi` to `claude`, so a
    // Pi plan run read Claude's `plan_auto_continue`. narrowProviderName knows all four (and
    // the legacy "claude-code" id), which is what the reconciler already used.
    const harness = narrowProviderName(relaunch.provider);
    const prefRows = await lifecycleRepo.getAllPreferences(db);
    const prefMap = toPrefMap(prefRows);
    const autoContinue = getHarnessBoolSetting(prefMap, harness, "plan_auto_continue");

    if (autoContinue) {
      console.log(`[${tag}] plan ready (${planPath}) — auto-continuing to implementation: ${subject}`);
      await lifecycleRepo.updateWorkspaceStatusOnly(workspaceId, "active", nowIso(), db);
      await startSession({
        workspaceId,
        prompt: buildImplementPrompt(),
        agentCommand: relaunch.agentCommand,
        agentArgs: relaunch.agentArgs,
        permissionPromptTool: relaunch.permissionPromptTool,
        planMode: false,
        provider: relaunch.provider,
        triggerType: "plan-implement",
        profile: relaunch.profile,
      });
      broadcast?.(projectId, "issue_updated");
    } else {
      console.log(`[${tag}] plan ready (${planPath}) — awaiting human approval: ${subject}`);
      await lifecycleRepo.updateWorkspacePendingPlan(workspaceId, planPath, "awaiting-plan-approval", nowIso(), db);
      broadcast?.(projectId, "issue_updated");
    }
  } catch (err) {
    console.error(`[${tag}] plan completion handling failed: ${subject}`, err);
  }
}
