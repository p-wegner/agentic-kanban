import { db, rawClient, rawWriteClient } from "../db/index.js";
import { workspaces, issues, projects, preferences, sessions } from "@agentic-kanban/shared/schema";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { applyMigrations } from "../db/manual-migrate.js";
import { deduplicateProjects } from "../services/project-registration.js";
import type * as agentServiceType from "../services/agent.service.js";
import * as agentService from "../services/agent.service.js";import * as gitService from "../services/git.service.js";
import { cleanupSiblingWorktrees } from "../services/workspace-repos.service.js";
import type { SessionManager } from "../services/session.manager.js";
import type { Database } from "../db/index.js";
import { logBoardHealthEvent } from "../repositories/board-health-events.repository.js";
import { setWorkspaceStatus } from "../repositories/workspace-status.repository.js";
import { reconcileAncestorBranchWorkspaces } from "./ancestor-branch-reconciler.js";
import { scanDoneUnmergedWorkspaces } from "./done-unmerged-invariant-scanner.js";
import { reapTerminalWorkspaces } from "./terminal-workspace-reaper.js";
import { finalizeMergeCleanup, reconcileMergedIssue } from "../services/merge-cleanup.service.js";
import { assertForeignKeysEnabled, alignForeignKeyActionsOnStartup } from "./fk-alignment.js";
import { checkForeignKeyViolations, logForeignKeyViolations } from "../db/fk-violations.js";
import { modelBelongsToProvider } from "@agentic-kanban/shared";
import { PREF_DEFAULT_MODEL, PREF_PROVIDER } from "../constants/preference-keys.js";
import { MODEL_PREF_KEYS_BY_PROVIDER } from "../services/effective-config.service.js";
import { narrowProviderName } from "../services/agent-provider.js";

/** Kill orphaned tsx server processes from previous hot-reload cycles (Windows only). */
export function shouldKillOrphanedServerProcess(input: {
  pid: number;
  commandLine: string;
  checkoutRoot: string;
  protectedPids?: Set<number>;
}): boolean {
  if (input.protectedPids?.has(input.pid)) return false;

  const cmd = input.commandLine.replace(/\\/g, "/").toLowerCase();
  const checkoutRoot = input.checkoutRoot.replace(/\\/g, "/").toLowerCase();
  if (!cmd.includes("src/index")) return false;
  if (!cmd.includes("tsx") && !cmd.includes("ts-node")) return false;

  // The startup cleanup is allowed to reap stale hot-reload children only from
  // the checkout that is currently booting. Worktree servers must never clean up
  // the main board checkout, and the main checkout must not clean up worktrees.
  return cmd.includes(checkoutRoot);
}

export async function killOrphanedServers(): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    const { execSync: _execSync } = await import("node:child_process");
    const wmic = _execSync(
      `wmic process where "name='node.exe'" get ProcessId,ParentProcessId,CommandLine /format:list`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: 8000 },
    );
    const myPid = process.pid;
    const lines = wmic.split(/\r?\n/);
    const procs: { pid: number; ppid: number; cmd: string }[] = [];
    let curCmd = "";
    let curPid = 0;
    let curPpid = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("CommandLine=")) curCmd = trimmed.slice("CommandLine=".length);
      if (trimmed.startsWith("ParentProcessId=")) curPpid = parseInt(trimmed.slice("ParentProcessId=".length), 10);
      if (trimmed.startsWith("ProcessId=")) curPid = parseInt(trimmed.slice("ProcessId=".length), 10);
      if (curCmd && curPid) { procs.push({ pid: curPid, ppid: curPpid, cmd: curCmd }); curCmd = ""; curPid = 0; curPpid = 0; }
    }
    // Collect the full ancestor chain of our process to avoid self-kill.
    const ppidMap = new Map(procs.map(p => [p.pid, p.ppid]));
    const ancestors = new Set<number>();
    let ancestor = myPid;
    for (let i = 0; i < 10; i++) {
      const parent = ppidMap.get(ancestor);
      if (!parent || parent === 0 || parent === ancestor) break;
      ancestors.add(parent);
      ancestor = parent;
    }
    let killed = 0;
    const checkoutRoot = process.cwd();
    const protectedPids = new Set(
      [
        process.env.KANBAN_BOARD_SERVER_PID,
        ...(process.env.KANBAN_PROTECTED_PIDS ?? "").split(","),
      ]
        .map((pid) => Number(pid))
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    );
    for (const p of procs) {
      if (p.pid === myPid || ancestors.has(p.pid)) continue;
      if (shouldKillOrphanedServerProcess({ pid: p.pid, commandLine: p.cmd, checkoutRoot, protectedPids })) {
        try {
          _execSync(`taskkill /PID ${p.pid} /T /F`, { stdio: "pipe", windowsHide: true, timeout: 5000 });
          console.log(`[startup] killed orphaned tsx server PID ${p.pid}`);
          killed++;
        } catch { /* already gone */ }
      }
    }
    if (killed > 0) {
      console.log(`[startup] killed ${killed} orphaned tsx server process(es) that may have held the DB locked`);
      // Brief pause to let SQLite release the lock
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err) {
    console.warn("[startup] orphan cleanup failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}

/**
 * One-time migration (#902): retire the global, provider-agnostic `default_model` pref.
 *
 * The global key was the structural footgun — a single model id fed to whichever provider
 * won, with only a silent-nullify guard between a stale Codex `gpt-5.5` and a doomed
 * `claude.exe --model gpt-5.5` launch (#696/#699). Model is now ONLY provider-scoped.
 *
 * Behavior: if a global value exists and belongs to the currently-active provider AND that
 * provider's scoped slot is empty, copy it across (preserve the user's intent). Then ALWAYS
 * delete the global key. A wrong-provider or already-superseded value is simply dropped.
 * Idempotent: once the key is gone this is a no-op.
 */
export async function migrateGlobalDefaultModelToProviderScope(database: Database = db): Promise<void> {
  const rows = await database
    .select({ key: preferences.key, value: preferences.value })
    .from(preferences)
    .where(eq(preferences.key, PREF_DEFAULT_MODEL));
  if (rows.length === 0) return;

  const globalValue = (rows[0].value ?? "").trim();
  if (globalValue) {
    const provider = narrowProviderName(
      (await database.select({ value: preferences.value }).from(preferences).where(eq(preferences.key, PREF_PROVIDER)))[0]?.value ?? undefined,
    );
    const scopedKey = MODEL_PREF_KEYS_BY_PROVIDER[provider as keyof typeof MODEL_PREF_KEYS_BY_PROVIDER];
    if (scopedKey && modelBelongsToProvider(globalValue, provider as "claude" | "codex" | "copilot" | "pi")) {
      const existing = (
        await database.select({ value: preferences.value }).from(preferences).where(eq(preferences.key, scopedKey))
      )[0]?.value?.trim();
      if (!existing) {
        const now = new Date().toISOString();
        await database.insert(preferences).values({ key: scopedKey, value: globalValue, updatedAt: now })
          .onConflictDoUpdate({ target: preferences.key, set: { value: globalValue, updatedAt: now } });
        console.log(`[startup] #902 migration: moved global default_model="${globalValue}" into ${scopedKey}`);
      }
    }
  }

  await database.delete(preferences).where(eq(preferences.key, PREF_DEFAULT_MODEL));
  console.log("[startup] #902 migration: deleted the global default_model pref (model is now provider-scoped only)");
}

/** Run database migrations, seed built-in tags and skills, deduplicate projects, disable auto_monitor, and backfill failure patterns. */
export async function runMigrations(): Promise<void> {
  // Cheap insurance: a verified snapshot before any schema change.
  try {
    const { createBackup } = await import("../db/backup.js");
    await createBackup("pre-migration");
  } catch (err) {
    console.warn("[backup] pre-migration backup failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }

  try {
    await applyMigrations(rawClient);
  } catch (err: unknown) {
    console.error("[startup] Migration failed:", err instanceof Error ? err.message : String(err));
    throw err;
  }

  try {
    const { ensureBuiltinTags, ensureBuiltinSkills } = await import("../db/seed.js");
    const { ensureBuiltinWorkflows } = await import("../db/builtin-workflows.js");
    await ensureBuiltinTags(db);
    await ensureBuiltinSkills(db);
    // Built-in skills must be seeded first — workflow nodes resolve skills by name.
    await ensureBuiltinWorkflows(db);
  } catch (err) {
    console.warn("[startup] ensureBuiltinTags/Skills/Workflows failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }

  try {
    await deduplicateProjects();
  } catch (err) {
    console.warn("[startup] project deduplication failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }

  // Disable auto_monitor on every startup — prevents mass agent spawns from idle workspaces
  const now = new Date().toISOString();
  await db.insert(preferences).values({ key: "auto_monitor", value: "false", updatedAt: now })
    .onConflictDoUpdate({ target: preferences.key, set: { value: "false", updatedAt: now } });
  console.log("[startup] auto_monitor disabled — re-enable in Settings → Workflow → Board Monitoring");

  // One-time migration (#902): the global provider-agnostic `default_model` pref is gone.
  // Move any live value into the active provider's scoped slot (if that slot is empty and the
  // model belongs to the provider) and DELETE the global key so a cross-provider model is
  // structurally unrepresentable. Idempotent — a no-op once the key is absent.
  try {
    await migrateGlobalDefaultModelToProviderScope(db);
  } catch (err) {
    console.warn("[startup] default_model provider-scope migration failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }

  // Backfill failure patterns from docs/learnings/ in all registered projects (non-fatal)
  try {
    const { backfillFromLearnings } = await import("../services/failure-pattern.service.js");
    const { resolve: pathResolve } = await import("node:path");
    const projRows = await db.select({ repoPath: projects.repoPath }).from(projects);
    for (const { repoPath } of projRows) {
      if (!repoPath) continue;
      const learningsDir = pathResolve(repoPath, "docs", "learnings");
      const count = await backfillFromLearnings(learningsDir, db);
      if (count > 0) console.log(`[startup] failure-pattern backfill: ingested ${count} learning(s) from ${learningsDir}`);
    }
  } catch (err) {
    console.warn("[startup] failure-pattern backfill failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Verify FK enforcement is live, then bring the on-disk DB's FK ACTIONS into line with
 * the Drizzle schema (arch-review #894). Migrations fixed the schema *shape* above, but
 * they cannot retro-fit an `ON DELETE` action a long-lived DB was created without —
 * SQLite has no `ALTER ... FOREIGN KEY`, so this drift previously only got repaired on a
 * manual `pnpm db:repair`. Run on every boot so the live board's FK actions can never
 * silently diverge from what `cascade-delete.ts` and the services assume.
 *
 * The pragma assertion is FATAL (a connection with FK enforcement off makes every
 * `onDelete` clause inert with no error — exactly the swallowed-catch hole in db/index.ts).
 * The action alignment is NON-fatal: the schema shape is already correct, and a rebuild
 * failure must not stop the board from booting.
 */
export async function alignLiveDbForeignKeys(): Promise<void> {
  // FATAL: both the read and the dedicated write connection must enforce FKs. If
  // PRAGMA foreign_keys=ON failed to apply on either, fail loud rather than run a
  // board where deletes silently leave orphans.
  await assertForeignKeysEnabled(rawClient, "read");
  await assertForeignKeysEnabled(rawWriteClient, "write");

  // NON-fatal: align ON DELETE/ON UPDATE actions on tables an older DB drifted on.
  try {
    await alignForeignKeyActionsOnStartup(rawClient);
  } catch (err) {
    console.warn(
      "[startup] FK-action alignment failed (non-fatal — schema shape is still up to date):",
      err instanceof Error ? err.message : String(err),
    );
  }

  // NON-fatal sweep of EXISTING data (#987): the pragma assertion above only guards
  // NEW writes on these connections — rows inserted by past connections that never
  // set `PRAGMA foreign_keys=ON` (ad-hoc scripts) can already violate FKs. Report
  // them LOUDLY; never auto-delete at startup — `pnpm db:repair` is the removal path.
  try {
    const violations = await checkForeignKeyViolations(rawClient);
    if (violations.length > 0) {
      logForeignKeyViolations(violations, "startup");
    }
  } catch (err) {
    console.warn(
      "[startup] PRAGMA foreign_key_check sweep failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Clean up stale sessions and reattach surviving agent processes. */
export async function cleanupStaleSessions(sessionManager: SessionManager, agentServiceModule = agentService): Promise<void> {
  const staleSessions = await db.select({
    id: sessions.id,
    workspaceId: sessions.workspaceId,
    pid: sessions.pid,
    executor: sessions.executor,
  }).from(sessions).where(eq(sessions.status, "running"));

  if (staleSessions.length === 0) return;

  console.log(`[startup] Checking ${staleSessions.length} running session(s)`);
  const now = new Date().toISOString();
  const dead = [];
  const alive = [];
  for (const s of staleSessions) {
    if (s.pid) {
      try {
        process.kill(s.pid, 0);
        alive.push(s);
      } catch {
        dead.push(s);
      }
    } else {
      dead.push(s);
    }
  }
  for (const s of dead) {
    await db.update(sessions).set({ status: "stopped", endedAt: now }).where(eq(sessions.id, s.id));
  }
  const deadWorkspaceIds = [...new Set(dead.map(s => s.workspaceId))];
  for (const wsId of deadWorkspaceIds) {
    await setWorkspaceStatus(db, wsId, "idle", { now });
  }
  if (dead.length > 0) {
    console.log(`[startup] ${dead.length} dead session(s) cleaned up`);
  }
  if (alive.length > 0) {
    console.log(`[startup] ${alive.length} session(s) have surviving agent processes — reattaching`);
    for (const s of alive) {
      if (!s.pid) continue;
      const wsRows = await db.select({ issueId: workspaces.issueId }).from(workspaces).where(eq(workspaces.id, s.workspaceId)).limit(1);
      let issueId = "";
      let projectId = "";
      if (wsRows.length > 0) {
        issueId = wsRows[0].issueId;
        const issueRows = await db.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, issueId)).limit(1);
        if (issueRows.length > 0) projectId = issueRows[0].projectId;
      }
      sessionManager.reattachSession({ sessionId: s.id, workspaceId: s.workspaceId, issueId, projectId, providerName: s.executor ?? undefined });
      agentServiceModule.reattachSession(
        s.id,
        s.pid,
        (event) => { sessionManager.handleOutput(s.id, event); },
        () => {
          sessionManager.notifyExternalExit(s.id, null).catch((err: unknown) => {
            console.error(`[startup] Failed to handle reattached session exit: sessionId=${s.id}`, err);
          });
        },
      );
    }
  }
}

/** Prune closed workspaces that still have a workingDir (stale git worktrees). */
export async function pruneStaleWorktrees(): Promise<void> {
  const staleWs = await db.select({ id: workspaces.id, branch: workspaces.branch, workingDir: workspaces.workingDir, issueId: workspaces.issueId })
    .from(workspaces)
    .where(eq(workspaces.status, "closed"));
  const staleWithWorktrees = staleWs.filter(ws => ws.workingDir);
  if (staleWithWorktrees.length === 0) return;

  console.log(`[startup] Pruning ${staleWithWorktrees.length} stale worktree(s)`);
  for (const ws of staleWithWorktrees) {
    try {
      const issueRows = await db.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, ws.issueId)).limit(1);
      if (issueRows.length > 0) {
        const projRows = await db.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, issueRows[0].projectId)).limit(1);
        if (projRows.length > 0) {
          const { repoPath } = projRows[0];
          try { await gitService.removeWorktree(repoPath, ws.workingDir!); } catch { /* locked — skip */ }
        }
      }
      // Multi-repo: sibling worktrees + branches too (no-op single-repo).
      // preserveUnmerged: this path prunes stale WORKTREES of closed workspaces — it
      // never deletes the leading branch, so an unmerged sibling branch (unshipped
      // work) must not be force-deleted either.
      await cleanupSiblingWorktrees(gitService, ws.id, db, { preserveUnmerged: true });
      await db.update(workspaces).set({ workingDir: null, updatedAt: new Date().toISOString() }).where(eq(workspaces.id, ws.id));
    } catch (err) {
      console.warn(`[startup] Failed to prune worktree for workspace ${ws.id}:`, err);
    }
  }
}

/** Abort any in-progress merges in all registered project repos (self-healing after hot-reload kills a merge mid-operation). */
export async function abortStaleMerges(): Promise<void> {
  try {
    const projectRows = await db.select({ repoPath: projects.repoPath }).from(projects);
    for (const { repoPath } of projectRows) {
      try {
        const inMerge = await gitService.isMergeInProgress(repoPath);
        if (inMerge) {
          console.log(`[startup] MERGE_HEAD detected in ${repoPath} — running git merge --abort to self-heal`);
          await gitService.abortMerge(repoPath);
          console.log(`[startup] merge --abort succeeded for ${repoPath}`);
        }
      } catch (err) {
        console.warn(`[startup] abortStaleMerges: failed for ${repoPath}:`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    console.warn("[startup] abortStaleMerges failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Abort any orphaned interactive rebases left behind in active worktrees.
 * A rebase interrupted by a hot-reload (or by killing a mid-flight merge agent)
 * leaves `.git/rebase-merge` or `.git/rebase-apply` in the worktree, which
 * blocks subsequent operations.
 */
export async function abortStaleRebases(): Promise<void> {
  try {
    const wsRows = await db.select({ workingDir: workspaces.workingDir }).from(workspaces);
    const seen = new Set<string>();
    for (const { workingDir } of wsRows) {
      if (!workingDir || seen.has(workingDir)) continue;
      seen.add(workingDir);
      try {
        const inRebase = await gitService.isRebaseInProgress(workingDir);
        if (inRebase) {
          console.log(`[startup] orphan rebase detected in ${workingDir} — running git rebase --abort to self-heal`);
          await gitService.abortRebase(workingDir);
          console.log(`[startup] rebase --abort succeeded for ${workingDir}`);
        }
      } catch (err) {
        console.warn(`[startup] abortStaleRebases: failed for ${workingDir}:`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    console.warn("[startup] abortStaleRebases failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}

/** Check if main checkout HEAD is on defaultBranch for each project; log a warning if drifted. */
export async function checkMainCheckoutHeads(): Promise<void> {
  try {
    const projectRows = await db.select({ repoPath: projects.repoPath, defaultBranch: projects.defaultBranch, name: projects.name }).from(projects);
    for (const { repoPath, defaultBranch, name } of projectRows) {
      if (!defaultBranch) continue;
      try {
        const currentBranch = await gitService.getCurrentBranch(repoPath);
        if (currentBranch !== defaultBranch) {
          console.warn(`[startup] WARNING: main checkout HEAD for project '${name}' (${repoPath}) is on '${currentBranch}', expected '${defaultBranch}'. Merge-pipeline ops will be refused until HEAD is restored.`);
        } else {
          console.log(`[startup] main checkout HEAD for project '${name}': OK (on '${defaultBranch}')`);
        }
      } catch (err) {
        console.warn(`[startup] checkMainCheckoutHeads: failed for ${repoPath}:`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    console.warn("[startup] checkMainCheckoutHeads failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Reconcile workspaces whose branch was merged (mergedAt IS NOT NULL) but whose
 * status was reset to something other than "closed" — e.g. when cleanupStaleSessions()
 * marked a dead session's workspace as "idle" after the server died mid-merge-response.
 *
 * Must run AFTER cleanupStaleSessions() so it can override any incorrect status reset.
 */
export async function reconcileSilentlyMergedWorkspaces(database: Database = db): Promise<void> {
  try {
  const stale = await database
      .select({
        id: workspaces.id,
        issueId: workspaces.issueId,
        mergedAt: workspaces.mergedAt,
        closedAt: workspaces.closedAt,
        branch: workspaces.branch,
        isDirect: workspaces.isDirect,
        repoPath: projects.repoPath,
        issueNumber: issues.issueNumber,
        projectId: issues.projectId,
      })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .innerJoin(projects, eq(issues.projectId, projects.id))
      .where(
        // mergedAt is set (git merge already landed) but workspace is not closed
        and(isNotNull(workspaces.mergedAt), ne(workspaces.status, "closed")),
      );

    if (stale.length === 0) return;

    console.log(`[startup] Reconciling ${stale.length} silently-merged workspace(s) left open by a dropped HTTP response`);
    const now = new Date().toISOString();

    for (const ws of stale) {
      try {
        if (!ws.isDirect && ws.repoPath && ws.branch) {
          try {
            await gitService.deleteBranch(ws.repoPath, ws.branch);
          } catch (err) {
            console.warn(
              `[startup] reconcileSilentlyMergedWorkspaces: failed to delete branch ${ws.branch} for workspace ${ws.id}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
        // Converge the issue to Done first via the shared idempotent helper, so a
        // dropped merge response still lands the issue even if the later workspace
        // close throws (mirrors the #668 no-rollback guarantee).
        await reconcileMergedIssue({
          database,
          issueId: ws.issueId,
          now,
          projectId: ws.projectId,
        });
        await finalizeMergeCleanup({
          database,
          workspaceId: ws.id,
          issueId: ws.issueId,
          now,
          closedAt: ws.closedAt ?? now,
          mergedAt: ws.mergedAt!,
          workingDir: null,
          projectId: ws.projectId,
        });

        console.log(
          `[startup] auto-Done audit: issue=${ws.issueNumber ?? "?"} ws=${ws.id} mergedAt=${ws.mergedAt} reconciledAt=${now}`,
        );
        try {
          await logBoardHealthEvent({
            projectId: ws.projectId,
            cycleId: `startup-reconcile-${ws.id}`,
            eventType: "action",
            category: "merge",
            issueNumber: ws.issueNumber ?? undefined,
            summary: `Startup reconciliation: workspace ${ws.branch} was already merged at ${ws.mergedAt} but left open by a dropped HTTP response. Closed workspace and moved issue to Done.`,
            details: { workspaceId: ws.id, mergedAt: ws.mergedAt, reconciledAt: now },
          }, database);
        } catch { /* health event logging is non-fatal */ }
      } catch (err) {
        console.warn(`[startup] reconcileSilentlyMergedWorkspaces: failed for workspace ${ws.id}:`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    console.warn("[startup] reconcileSilentlyMergedWorkspaces failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}

/** Combined startup sequence: kill orphans, migrate, seed, dedup, abort stale merges, clean sessions/worktrees. */
export async function runStartupTasks(sessionManager: SessionManager, _deps?: { agentService?: typeof agentServiceType }): Promise<void> {
  await killOrphanedServers();
  await runMigrations();
  await alignLiveDbForeignKeys();
  await abortStaleMerges();
  await abortStaleRebases();
  await cleanupStaleSessions(sessionManager);
  await reconcileSilentlyMergedWorkspaces();
  try {
    // Multi-repo crash gap: a crash between the leading merge and the sibling merges
    // strands sibling repos unmerged on a mergedAt-stamped workspace — no other startup
    // reconciler sees them. Dynamically imported: merge-workflow pulls in the whole
    // merge pipeline, which other startup-task consumers don't need at module load.
    const { reconcileStrandedSiblingMerges } = await import("./merge-workflow.js");
    await reconcileStrandedSiblingMerges();
  } catch (err) {
    console.warn("[startup] reconcileStrandedSiblingMerges failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
  try {
    await reconcileAncestorBranchWorkspaces();
  } catch (err) {
    console.warn("[startup] reconcileAncestorBranchWorkspaces failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
  try {
    await scanDoneUnmergedWorkspaces({ reopenToInReview: false });
  } catch (err) {
    console.warn("[startup] scanDoneUnmergedWorkspaces failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
  try {
    await reapTerminalWorkspaces();
  } catch (err) {
    console.warn("[startup] reapTerminalWorkspaces failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
  await pruneStaleWorktrees();
  await checkMainCheckoutHeads();
}
