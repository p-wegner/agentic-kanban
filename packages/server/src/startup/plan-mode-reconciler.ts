import { readFileSync } from "node:fs";
import { issues, preferences, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";
import { extractPlanFromMessages, writePlanFile, buildImplementPrompt } from "../services/plan-mode.service.js";
import { getHarnessBoolSetting } from "../services/harness-settings.js";
import { narrowProviderName } from "../services/agent-provider.js";
import { toExecutorProvider } from "../services/agent-settings.service.js";
import { sessionOutputPath } from "../lib/session-paths.js";
import { emitButlerSystemEvent } from "../services/butler-event-feed.js";
import { PREF_RECONCILER_STRANDED_PLAN_ENABLED } from "../constants/preference-keys.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";

export interface StrandedPlanReconcilerDeps {
  database?: Database;
  getSessionManager: () => SessionManager;
  boardEvents: BoardEvents;
  /**
   * Override enabled state for testing. When undefined (production path), the reconciler
   * reads the live `reconciler_stranded_plan_enabled` preference from the DB at call time.
   */
  enabled?: boolean;
}

/** Read a finished session's raw stdout (.out) file as one synthetic message for plan scanning. */
function readSessionOutputAsMessages(sessionId: string): AgentOutputMessage[] {
  try {
    const data = readFileSync(sessionOutputPath(sessionId), "utf-8");
    if (!data) return [];
    return [{ type: "stdout", sessionId, data }];
  } catch {
    return [];
  }
}

/**
 * Recover plan-mode workspaces stranded by the #924 bug: planMode left stuck `true`
 * after a plan run completed, so the workspace sits idle/In-Progress forever and every
 * follow-up turn re-runs read-only/plan-only. The forward fix (session-lifecycle's
 * `finalizePlanModeExit`) prevents NEW strands; this reconciler heals ones that already
 * happened (or that landed before the fix shipped) and survives a crash mid-plan-handler.
 *
 * For each candidate (planMode=true, idle, non-direct, no running session, with a prior
 * completed plan-trigger session and no pendingPlanPath):
 *   - scan the prior plan session's stdout for the `===PLAN BEGIN/END===` block;
 *   - plan found  → write PLAN.md, clear planMode, then auto-continue (status active +
 *     implement session) or park at awaiting-plan-approval per `plan_auto_continue`;
 *   - no plan     → clear planMode and mark the workspace blocked (needs-attention),
 *     so a normal turn implements instead of re-running read-only.
 *
 * Idempotent: clearing planMode / setting pendingPlanPath makes the workspace fail the
 * candidate filter on the next tick, and launching the implement session flips it to active.
 */
export async function reconcileStrandedPlanModeWorkspaces(deps: StrandedPlanReconcilerDeps): Promise<number> {
  const database = deps.database ?? db;
  const { getSessionManager, boardEvents } = deps;

  const isEnabled = deps.enabled !== undefined
    ? deps.enabled
    : await (async () => {
        try {
          const row = await database.select({ value: preferences.value }).from(preferences)
            .where(eq(preferences.key, PREF_RECONCILER_STRANDED_PLAN_ENABLED)).limit(1);
          return row.length === 0 || row[0].value !== "false";
        } catch {
          return true;
        }
      })();
  if (!isEnabled) {
    console.log("[reconcile] stranded-plan reconciler disabled via preference — skipping tick");
    return 0;
  }

  const prefRows = await database.select({ key: preferences.key, value: preferences.value }).from(preferences);
  const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));

  const candidates = await database
    .select({
      wsId: workspaces.id,
      workingDir: workspaces.workingDir,
      provider: workspaces.provider,
      claudeProfile: workspaces.claudeProfile,
      agentCommand: workspaces.agentCommand,
      pendingPlanPath: workspaces.pendingPlanPath,
      issueNumber: issues.issueNumber,
      projectId: issues.projectId,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(and(
      eq(workspaces.planMode, true),
      eq(workspaces.isDirect, false),
      eq(workspaces.status, "idle"),
    ));

  let recovered = 0;
  for (const c of candidates) {
    // A workspace already parked awaiting approval is not stranded — skip.
    if (c.pendingPlanPath) continue;
    // Skip if a session is currently running for this workspace.
    const running = await database.select({ id: sessions.id }).from(sessions)
      .where(and(eq(sessions.workspaceId, c.wsId), eq(sessions.status, "running"))).limit(1);
    if (running.length > 0) continue;
    // Require a PRIOR completed plan-trigger session — otherwise nothing ran yet.
    const planSession = await database
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.workspaceId, c.wsId), eq(sessions.triggerType, "plan")))
      .orderBy(desc(sessions.startedAt))
      .limit(1);
    if (planSession.length === 0) continue;

    const now = () => new Date().toISOString();
    try {
      const messages = readSessionOutputAsMessages(planSession[0].id);
      const plan = c.workingDir ? extractPlanFromMessages(messages) : null;

      if (!plan || !c.workingDir) {
        await database.update(workspaces)
          .set({ planMode: false, status: "blocked", updatedAt: now() })
          .where(eq(workspaces.id, c.wsId));
        boardEvents.broadcast(c.projectId, "workflow_error");
        emitButlerSystemEvent({
          projectId: c.projectId,
          kind: "session_failed",
          workspaceId: c.wsId,
          text: `Plan-mode workspace ${c.wsId} (#${c.issueNumber ?? "?"}) was stranded (planMode stuck, no recoverable plan). Cleared plan mode and marked it blocked — a normal turn will now implement.`,
        });
        console.warn(`[reconcile] stranded plan-mode workspace ${c.wsId} (#${c.issueNumber ?? "?"}): no recoverable plan — cleared planMode, marked blocked`);
        recovered++;
        continue;
      }

      const planPath = writePlanFile(c.workingDir, plan);
      const harness = narrowProviderName(c.provider ?? undefined);
      const autoContinue = getHarnessBoolSetting(prefMap, harness, "plan_auto_continue");

      if (autoContinue) {
        await database.update(workspaces).set({ planMode: false, status: "active", updatedAt: now() }).where(eq(workspaces.id, c.wsId));
        await getSessionManager().startSession({
          workspaceId: c.wsId,
          prompt: buildImplementPrompt(),
          agentCommand: c.agentCommand ?? undefined,
          claudeProfile: c.claudeProfile ?? undefined,
          planMode: false,
          provider: toExecutorProvider(harness),
          triggerType: "plan-implement",
          ...(c.claudeProfile ? { profile: { provider: harness, name: c.claudeProfile } } : {}),
        });
        boardEvents.broadcast(c.projectId, "issue_updated");
        console.log(`[reconcile] stranded plan-mode workspace ${c.wsId} (#${c.issueNumber ?? "?"}): recovered plan (${planPath}) — auto-continuing to implementation`);
      } else {
        await database.update(workspaces)
          .set({ planMode: false, pendingPlanPath: planPath, status: "awaiting-plan-approval", updatedAt: now() })
          .where(eq(workspaces.id, c.wsId));
        boardEvents.broadcast(c.projectId, "issue_updated");
        console.log(`[reconcile] stranded plan-mode workspace ${c.wsId} (#${c.issueNumber ?? "?"}): recovered plan (${planPath}) — parked awaiting approval`);
      }
      recovered++;
    } catch (err) {
      console.warn(`[reconcile] failed to recover stranded plan-mode workspace ${c.wsId}:`, err instanceof Error ? err.message : err);
    }
  }
  if (recovered > 0) console.log(`[reconcile] recovered ${recovered} stranded plan-mode workspace(s)`);
  return recovered;
}

const DEFAULT_INTERVAL_MS = 60_000;

let activeStrandedPlanTimeout: ReturnType<typeof setTimeout> | null = null;
let activeStrandedPlanInterval: ReturnType<typeof setInterval> | null = null;

export function stopStrandedPlanReconciler(): void {
  if (activeStrandedPlanTimeout !== null) {
    clearTimeout(activeStrandedPlanTimeout);
    activeStrandedPlanTimeout = null;
  }
  if (activeStrandedPlanInterval !== null) {
    clearInterval(activeStrandedPlanInterval);
    activeStrandedPlanInterval = null;
  }
}

/** Run the reconciler shortly after boot (crash recovery) and then on an interval. */
export function startStrandedPlanReconciler(deps: StrandedPlanReconcilerDeps, intervalMs = DEFAULT_INTERVAL_MS): ReturnType<typeof setInterval> {
  stopStrandedPlanReconciler();

  const tick = () => {
    reconcileStrandedPlanModeWorkspaces(deps).catch((err) => console.warn("[reconcile] plan cycle error:", err instanceof Error ? err.message : err));
  };
  activeStrandedPlanTimeout = setTimeout(tick, 30_000);
  activeStrandedPlanInterval = setInterval(tick, intervalMs);
  return activeStrandedPlanInterval;
}
