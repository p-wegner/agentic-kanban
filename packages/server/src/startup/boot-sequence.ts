import { fileURLToPath } from "node:url";
import type * as agentService from "../services/agent.service.js";
import type { createWorkflowEngine } from "./exit-workflow.js";
import { runCriticalStartupTasks } from "./startup-tasks.js";
import { reapOrphanServiceStacksOnce } from "./service-stack-reaper.js";
import { assertNoCommittedConflictMarkers } from "./conflict-marker-scanner.js";
import { runSessionRestore } from "./session-restore.js";
import type { SessionManager } from "../services/session.manager.js";

/**
 * Runs the sequential, must-precede-serving half of startup — extracted from
 * `server-start.ts` (#873). Order matters and is preserved exactly: stale
 * session cleanup and migrations, then orphan service-stack reap (which
 * depends on stale-session cleanup having already run), then the two
 * non-fatal preflight checks, then session restore (which needs the workflow
 * engine wired first). Every git-spawning reconciler stays OUT of this
 * sequence, in the deferred phase started after `serve()` (#282).
 */
export async function runBootSequence(
  sessionManager: SessionManager,
  workflow: ReturnType<typeof createWorkflowEngine>,
  agentServiceModule: typeof agentService,
): Promise<void> {
  // #282 — only the work that must precede serving: process cleanup, migrations, FK
  // assertions, session settling. Every git-spawning reconciler moved to the deferred
  // phase started after `serve()` below.
  await runCriticalStartupTasks(sessionManager, { agentService: agentServiceModule });

  // Reap orphan service stacks after stale-session cleanup (runs inside the critical phase).
  // Boot pass runs BEFORE setupRoutes so no HTTP create can race it — and it does NOT
  // shield mid-provision null-state rows (a crash-mid-`up` leaves no state; that IS the
  // orphan to reclaim). The periodic pass (background-services) shields those instead,
  // since it runs concurrently with live creates. Both share this one engine (#52).
  await reapOrphanServiceStacksOnce({ shieldMidProvision: false, logLabel: "startup" });

  // Boot preflight (#55): fail LOUDLY on the silent DooD misconfigs (undialable
  // KANBAN_SERVICE_HOST, a daemon that can't see the data root). No-op unless a project
  // declares an enabled stack AND docker is available; never blocks startup.
  try {
    const { runServiceStackPreflight } = await import("./service-stack-preflight.js");
    const { anyProjectHasEnabledServiceStack } = await import("../repositories/workspace-service-state.repository.js");
    const { DATA_DIR } = await import("../db/data-dir.js");
    await runServiceStackPreflight({ dataRoot: DATA_DIR, hasEnabledStack: anyProjectHasEnabledServiceStack });
  } catch (err) {
    console.warn("[services-preflight] preflight bootstrap failed (non-fatal):", err instanceof Error ? err.message : err);
  }

  // Fail-fast guard: scan committed source files for conflict markers.
  // Logs a [fatal] alert for every affected file+line.  Non-crashing so the
  // server can still start and the developer can reach the board to fix it.
  try {
    const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
    assertNoCommittedConflictMarkers(repoRoot);
  } catch (err) {
    console.warn("[conflict-marker-scanner] scan failed (non-fatal):", err instanceof Error ? err.message : err);
  }

  await runSessionRestore(workflow);
}
