import { db, rawClient } from "../db/index.js";
import { workspaces, issues, projects, preferences, sessions } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { applyMigrations } from "../db/manual-migrate.js";
import { deduplicateProjects } from "../services/project-registration.js";
import type * as agentServiceType from "../services/agent.service.js";
import * as agentService from "../services/agent.service.js";import * as gitService from "../services/git.service.js";
import type { SessionManager } from "../services/session.manager.js";

/** Kill orphaned tsx server processes from previous hot-reload cycles (Windows only). */
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
    for (const p of procs) {
      if (p.pid === myPid || ancestors.has(p.pid)) continue;
      const cmd = p.cmd.replace(/\\/g, "/");
      // Match tsx-based server processes (hot-reload survivors) for the main server entry point.
      // Avoid killing worktree-specific servers by requiring the cmd NOT to contain a worktree path marker.
      if ((cmd.includes("tsx") || cmd.includes("ts-node")) && cmd.includes("src/index") && !cmd.includes(".worktrees")) {
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

/** Run database migrations, seed built-in tags and skills, deduplicate projects, and disable auto_monitor. */
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

/** Combined startup sequence: kill orphans, migrate, seed, dedup, abort stale merges, clean sessions/worktrees. */
export async function runStartupTasks(sessionManager: SessionManager, _deps?: { agentService?: typeof agentServiceType }): Promise<void> {
  await killOrphanedServers();
  await runMigrations();
  await abortStaleMerges();
  await abortStaleRebases();
  await cleanupStaleSessions(sessionManager);
  await pruneStaleWorktrees();
}
