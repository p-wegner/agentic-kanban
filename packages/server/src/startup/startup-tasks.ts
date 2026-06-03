import { db, rawClient } from "../db/index.js";
import { workspaces, issues, projects, preferences, sessions } from "@agentic-kanban/shared/schema";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { applyMigrations } from "../db/manual-migrate.js";
import { deduplicateProjects } from "../services/project-registration.js";
import type * as agentServiceType from "../services/agent.service.js";
import * as agentService from "../services/agent.service.js";import * as gitService from "../services/git.service.js";
import type { SessionManager } from "../services/session.manager.js";
import type { Database } from "../db/index.js";
import { moveIssueToDone, updateWorkspaceStatus } from "../repositories/workspace.repository.js";
import { logBoardHealthEvent } from "../repositories/board-health-events.repository.js";

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
    await db.update(workspaces).set({ status: "idle", updatedAt: now }).where(eq(workspaces.id, wsId));
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
        issueNumber: issues.issueNumber,
        projectId: issues.projectId,
      })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(
        // mergedAt is set (git merge already landed) but workspace is not closed
        and(isNotNull(workspaces.mergedAt), ne(workspaces.status, "closed")),
      );

    if (stale.length === 0) return;

    console.log(`[startup] Reconciling ${stale.length} silently-merged workspace(s) left open by a dropped HTTP response`);
    const now = new Date().toISOString();

    for (const ws of stale) {
      try {
        await updateWorkspaceStatus(ws.id, "closed", {
          closedAt: ws.closedAt ?? now,
          mergedAt: ws.mergedAt!,
          readyForMerge: false,
          workingDir: null,
        }, database);
        await moveIssueToDone(ws.id, ws.issueId, now, database);

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

        console.log(`[startup] reconciled workspace ${ws.id} (issue #${ws.issueNumber ?? ws.issueId}, mergedAt=${ws.mergedAt})`);
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
  await abortStaleMerges();
  await abortStaleRebases();
  await cleanupStaleSessions(sessionManager);
  await reconcileSilentlyMergedWorkspaces();
  await pruneStaleWorktrees();
  await checkMainCheckoutHeads();
}
