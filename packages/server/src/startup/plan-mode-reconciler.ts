import { readFileSync } from "node:fs";
import { issues, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import type { BoardEventSink } from "../services/board-events.js";
import type { SessionLauncher } from "../services/session.manager.js";
import { extractPlanFromMessages } from "../services/plan-mode.service.js";
import { narrowProviderName } from "../services/agent-provider.js";
import { toExecutorProvider } from "../services/agent-settings.service.js";
import { sessionOutputPath } from "../lib/session-paths.js";
import { PREF_RECONCILER_STRANDED_PLAN_ENABLED } from "../constants/preference-keys.js";
import { finalizePlanModeExit } from "../services/session-manager/plan-mode-exit.js";
import type { StartSessionOptions } from "../services/session-manager/types.js";
import { toProfileSelection } from "@agentic-kanban/shared/lib/profile-selection";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";

export interface StrandedPlanReconcilerDeps {
  database?: Database;
  getSessionManager: () => SessionLauncher;
  boardEvents: BoardEventSink;
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

  // ONE short-TTL cached prefs scan per tick (#402) serves both the live enabled
  // check and the prefMap below. A read failure keeps the previous fail-open behaviour.
  const prefRows = await getAllPreferencesCached(database).catch(() => null);
  const prefMap = new Map((prefRows ?? []).map((r) => [r.key, r.value]));
  const isEnabled = deps.enabled !== undefined
    ? deps.enabled
    : prefRows === null || prefMap.get(PREF_RECONCILER_STRANDED_PLAN_ENABLED) !== "false";
  if (!isEnabled) {
    console.log("[reconcile] stranded-plan reconciler disabled via preference — skipping tick");
    return 0;
  }

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

    try {
      const messages = readSessionOutputAsMessages(planSession[0].id);
      const plan = c.workingDir ? extractPlanFromMessages(messages) : null;
      const harness = narrowProviderName(c.provider ?? undefined);

      // #544: this used to re-state the whole three-outcome table inline (no plan ->
      // blocked; plan -> auto-continue or park), so the #924 recovery path could drift
      // from the live exit path it exists to stand in for. One implementation now.
      await finalizePlanModeExit(
        c.wsId,
        0, // a reconciled workspace has no exit code; a recovered plan is treated as clean.
        plan,
        {
          agentCommand: c.agentCommand ?? undefined,
          agentArgs: undefined,
          permissionPromptTool: undefined,
          provider: toExecutorProvider(harness),
          profile: toProfileSelection(c.provider, c.claudeProfile),
        },
        {
          db: database,
          workspaceWorkingDir: c.workingDir,
          projectId: c.projectId,
          startSession: (opts: StartSessionOptions) => getSessionManager().startSession(opts),
          broadcast: (projectId, event) => boardEvents.broadcast(projectId, event),
          logTag: "reconcile",
          subject: `stranded plan-mode workspace ${c.wsId} (#${c.issueNumber ?? "?"})`,
        },
      );
      recovered++;
    } catch (err) {
      console.warn(`[reconcile] failed to recover stranded plan-mode workspace ${c.wsId}:`, err instanceof Error ? err.message : err);
    }
  }
  if (recovered > 0) console.log(`[reconcile] recovered ${recovered} stranded plan-mode workspace(s)`);
  return recovered;
}

const DEFAULT_INTERVAL_MS = 60_000;

let activeStrandedPlanSweep: PeriodicSweepHandle | null = null;

export function stopStrandedPlanReconciler(): void {
  activeStrandedPlanSweep?.stop();
  activeStrandedPlanSweep = null;
}

/** Run the reconciler shortly after boot (crash recovery) and then on an interval. */
export function startStrandedPlanReconciler(deps: StrandedPlanReconcilerDeps, intervalMs = DEFAULT_INTERVAL_MS): PeriodicSweepHandle {
  stopStrandedPlanReconciler();
  activeStrandedPlanSweep = startPeriodicSweep({
    name: "reconcile",
    tick: () => reconcileStrandedPlanModeWorkspaces(deps),
    bootDelayMs: 30_000,
    intervalMs,
  });
  return activeStrandedPlanSweep;
}

