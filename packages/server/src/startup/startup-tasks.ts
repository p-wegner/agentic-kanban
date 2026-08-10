import { existsSync } from "node:fs";
import { db, rawClient, rawWriteClient } from "../db/index.js";
import { workspaces, issues, projects, preferences, sessions, pluginViewProcesses } from "@agentic-kanban/shared/schema";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { applyMigrations } from "../db/manual-migrate.js";
import { deduplicateProjects, unregisterLeakedTempProjects, findProjectsWithMissingRepoPath } from "../services/project-registration.js";
import type * as agentServiceType from "../services/agent.service.js";
import * as agentService from "../services/agent.service.js";import * as gitService from "../services/git.service.js";
import { cleanupSiblingWorktrees } from "../services/workspace-repos.service.js";
import type { SessionManager } from "../services/session.manager.js";
import type { Database } from "../db/index.js";
import { logBoardHealthEvent } from "../repositories/board-health-events.repository.js";
import { setWorkspaceStatus } from "../repositories/workspace-status.repository.js";
import { reconcileAncestorBranchWorkspaces } from "./ancestor-branch-reconciler.js";
import { reconcileHandMergedBranches } from "./hand-merged-branch-reconciler.js";
import { scanDoneUnmergedWorkspaces } from "./done-unmerged-invariant-scanner.js";
import { reapTerminalWorkspaces } from "./terminal-workspace-reaper.js";
import { reconcileOrphanedWorktrees } from "./orphaned-worktree-reconciler.js";
import { finalizeMergeCleanup, reconcileMergedIssue } from "../services/merge-cleanup.service.js";
import { assertForeignKeysEnabled, alignForeignKeyActionsOnStartup } from "./fk-alignment.js";
import { checkForeignKeyViolations, logForeignKeyViolations } from "../db/fk-violations.js";
import { modelBelongsToProvider } from "@agentic-kanban/shared";
import { PREF_DEFAULT_MODEL, PREF_PROVIDER } from "../constants/preference-keys.js";
import { MODEL_PREF_KEYS_BY_PROVIDER } from "../services/effective-config.service.js";
import { narrowProviderName } from "../services/agent-provider.js";
import { listOsProcesses, taskkillTree } from "../services/process-exec.js";
import { refreshContainerMcpConfig } from "../services/devcontainer-workspace.service.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { clearWorkspaceWorkingDir } from "../repositories/workspace-crud.repository.js";

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
    // wmic was removed starting with Windows 11 24H2, which silently killed this whole
    // cleanup (the catch below swallowed the "'wmic' is not recognized" error every boot).
    // listOsProcesses() uses the Get-CimInstance PowerShell equivalent instead.
    const osProcs = await listOsProcesses();
    const myPid = process.pid;
    const procs: { pid: number; ppid: number; cmd: string }[] = osProcs.map((p) => ({ pid: p.pid, ppid: p.ppid, cmd: p.commandLine }));
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

  // #166: unregister leaked %TEMP% test/lab fixture projects (safe heuristic — repo path
  // gone from disk AND under the OS temp dir), then report any OTHER missing-repoPath
  // project so it stays visible instead of silently accumulating. Never auto-unregisters
  // a non-temp path — a briefly-unmounted drive must not nuke a real project.
  try {
    const removed = await unregisterLeakedTempProjects();
    if (removed.length > 0) {
      console.log(`[startup] Unregistered ${removed.length} leaked temp-fixture project(s): ${removed.map((p) => p.name).join(", ")}`);
    }
    const stillMissing = await findProjectsWithMissingRepoPath();
    if (stillMissing.length > 0) {
      console.warn(`[startup] ${stillMissing.length} registered project(s) have a missing repoPath (not auto-removed — outside the temp dir):`);
      for (const p of stillMissing) {
        console.warn(`[startup]   "${p.name}" -> ${p.repoPath}`);
      }
    }
  } catch (err) {
    console.warn("[startup] leaked temp-project cleanup failed (non-fatal):", err instanceof Error ? err.message : String(err));
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
    containerId: sessions.containerId,
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
        s.containerId ?? undefined,
      );

      // #156: the containerized agent survived the restart, but the board's MCP
      // HTTP bridge did not — it dies on every shutdown (incl. SIGTERM/hot-reload)
      // and comes back with a fresh port+token. Rewrite this workspace's mounted
      // config with the new values so its board tool calls stop 401ing/timing out.
      if (s.containerId) {
        try {
          const configPath = await refreshContainerMcpConfig(s.workspaceId);
          if (configPath) {
            console.log(`[startup] refreshed container MCP config on reattach: workspaceId=${s.workspaceId} path=${configPath}`);
            if (issueId) {
              await insertIssueComment({
                issueId,
                workspaceId: s.workspaceId,
                kind: "note",
                author: "system",
                body: "Server restarted while this containerized agent was running. Its board MCP token/port were refreshed on reattach so board tool calls keep working.",
                createdAt: now,
              }).catch((err) => {
                console.warn(`[startup] failed to record MCP-refresh comment: workspaceId=${s.workspaceId}`, err);
              });
            }
          } else {
            console.warn(`[startup] could not refresh container MCP config on reattach (bridge unavailable): workspaceId=${s.workspaceId}`);
          }
        } catch (err) {
          console.warn(`[startup] container MCP config refresh failed on reattach: workspaceId=${s.workspaceId}`, err);
        }
      }
    }
  }
}

/**
 * Reap plugin view child servers (`views[].serve`) left running by the previous
 * server generation (#228). `tsx watch` restarts the backend on every
 * server-source edit without killing the children it had spawned; the new
 * process has no in-memory handle on them, so `plugin_view_processes` — a PID
 * persisted at spawn time (see `plugin-views.service.ts` via the injected
 * `persistViewProcess` hook) — is the only record of them. Every row found here
 * predates this process, so unlike `cleanupStaleSessions` there is no "reattach
 * the survivor" branch: a live process is unconditionally killed, and the row is
 * dropped either way.
 *
 * A bare `process.kill(pid, 0)` check is NOT enough before killing: PIDs get
 * recycled, and on this dev machine a fresh unrelated process (another agent's
 * dev server, a shell) can easily land on a PID a stale row remembers minutes
 * later. Cross-check the live process's command line against the `command` this
 * row persisted at spawn time — the same guard `shouldKillOrphanedServerProcess`
 * above applies for the tsx-server sweep — before killing anything.
 */
export async function reapOrphanedPluginViewProcesses(database: Database = db): Promise<void> {
  const rows = await database.select().from(pluginViewProcesses);
  if (rows.length === 0) return;

  console.log(`[startup] Checking ${rows.length} plugin view server(s) from the previous server generation`);
  const osProcs = await listOsProcesses();
  const commandLineByPid = new Map(osProcs.map((p) => [p.pid, p.commandLine]));
  let reaped = 0;
  for (const row of rows) {
    const liveCommandLine = commandLineByPid.get(row.pid);
    const stillTheSameProcess = liveCommandLine !== undefined && liveCommandLine.includes(row.command);
    if (stillTheSameProcess) {
      try {
        if (process.platform === "win32") {
          await taskkillTree(row.pid);
        } else {
          process.kill(row.pid, "SIGKILL");
        }
        reaped++;
      } catch (err) {
        console.warn(`[startup] failed to kill orphaned plugin view server PID ${row.pid} (non-fatal):`, err instanceof Error ? err.message : String(err));
      }
    } else if (liveCommandLine !== undefined) {
      console.warn(`[startup] plugin view server PID ${row.pid} is now a different process (command line no longer matches) — skipping kill, dropping stale row`);
    }
    await database.delete(pluginViewProcesses).where(eq(pluginViewProcesses.id, row.id));
  }
  if (reaped > 0) {
    console.log(`[startup] killed ${reaped} orphaned plugin view server process(es)`);
  }
}

/**
 * Command-line markers of board-spawned child web servers that are safe to reap
 * once their parent is gone. Deliberately narrow: each is a short-lived static
 * file/preview server the board starts on behalf of a plugin view or a review
 * artifact, never a long-lived service and never an agent process.
 *
 * NOT in this list, on purpose: `scripts/dev.mjs` (a supervisor another agent's
 * worktree may legitimately own), any `tsx`/backend process, and anything
 * agent-related. Killing a dev supervisor is the documented never-do.
 */
const REAPABLE_CHILD_SERVER_MARKERS = [
  "serve.mjs",
  "review-server.mjs",
  "ui-map-serve.mjs",
];

/**
 * Sweep board-spawned child servers whose parent process no longer exists (#281).
 *
 * Complements `reapOrphanedPluginViewProcesses`, which can only reap what the DB
 * remembers. Observed on this dev box: **85** `serve.mjs`-family processes with a
 * dead parent, the oldest 4 days old — spawned by server generations that predate
 * PID persistence, or by tests that spawn a `serve.mjs` out of a temp
 * `plugin-test-plugin-<id>` directory and never reap them. They accumulate
 * indefinitely because nothing owns them.
 *
 * Two conditions must BOTH hold before killing, which is what makes this safe to
 * run unattended:
 *  1. the command line matches `REAPABLE_CHILD_SERVER_MARKERS`, and
 *  2. the parent PID is not among the live processes — i.e. it is a true orphan,
 *     so no supervisor is going to miss it.
 *
 * A process whose parent is alive is left strictly alone: that is someone's
 * running plugin view, possibly in another worktree.
 */
export async function reapParentlessChildServers(): Promise<number> {
  let osProcs: Awaited<ReturnType<typeof listOsProcesses>>;
  try {
    osProcs = await listOsProcesses();
  } catch (err) {
    console.warn("[startup] could not enumerate processes for orphan sweep (non-fatal):", err instanceof Error ? err.message : String(err));
    return 0;
  }

  const livePids = new Set(osProcs.map((p) => p.pid));
  const orphans = osProcs.filter((proc) => {
    if (proc.pid === process.pid) return false;
    const cmd = proc.commandLine || "";
    if (!REAPABLE_CHILD_SERVER_MARKERS.some((marker) => cmd.includes(marker))) return false;
    // ppid 0 means "unknown" from the enumerator, not "orphan" — don't guess.
    if (!proc.ppid) return false;
    return !livePids.has(proc.ppid);
  });

  if (orphans.length === 0) return 0;

  let killed = 0;
  for (const orphan of orphans) {
    try {
      if (process.platform === "win32") {
        await taskkillTree(orphan.pid);
      } else {
        process.kill(orphan.pid, "SIGKILL");
      }
      killed++;
    } catch (err) {
      console.warn(`[startup] failed to reap parentless child server PID ${orphan.pid} (non-fatal):`, err instanceof Error ? err.message : String(err));
    }
  }
  console.log(`[startup] reaped ${killed}/${orphans.length} parentless child server process(es)`);
  return killed;
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
      await clearWorkspaceWorkingDir(ws.id, new Date().toISOString());
    } catch (err) {
      console.warn(`[startup] Failed to prune worktree for workspace ${ws.id}:`, err);
    }
  }
}

/**
 * Remove git worktrees that no workspace claims any more (#361).
 *
 * Complements `pruneStaleWorktrees`: that one starts from workspace rows and so cannot see a
 * worktree whose row has `workingDir = null` (which every completed merge produces). This starts
 * from `git worktree list`, so the nulled column makes the orphan visible rather than invisible.
 * Anything holding unlanded commits or uncommitted edits is reported and KEPT.
 */
export async function pruneOrphanedWorktrees(): Promise<void> {
  let projectRows: { id: string; repoPath: string; defaultBranch: string | null; name: string }[];
  try {
    projectRows = await db.select({ id: projects.id, repoPath: projects.repoPath, defaultBranch: projects.defaultBranch, name: projects.name }).from(projects);
  } catch (err) {
    console.warn("[startup] pruneOrphanedWorktrees: could not read projects:", err instanceof Error ? err.message : String(err));
    return;
  }

  for (const project of projectRows) {
    if (!project.repoPath || !existsSync(project.repoPath)) continue;
    try {
      // Every workspace row of the project, so a live workspace still holding a branch is
      // recognised as a claim even when its workingDir was cleared.
      const claims = await db.select({ workingDir: workspaces.workingDir, branch: workspaces.branch, status: workspaces.status })
        .from(workspaces)
        .innerJoin(issues, eq(workspaces.issueId, issues.id))
        .where(eq(issues.projectId, project.id));
      const report = await reconcileOrphanedWorktrees({
        repoPath: project.repoPath,
        baseBranch: project.defaultBranch || "master",
        claims,
        git: gitService,
      });
      if (report.removed.length > 0 || report.keptWithUnshippedWork.length > 0) {
        console.log(`[startup] orphaned worktrees for project '${project.name}': removed ${report.removed.length}, kept (unshipped work) ${report.keptWithUnshippedWork.length}`);
      }
    } catch (err) {
      console.warn(`[startup] pruneOrphanedWorktrees failed for project '${project.name}' (non-fatal):`, err instanceof Error ? err.message : String(err));
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
 * Path A of the interrupted-merge recovery pair. Re-exported from its own module (#380) so
 * the ancestor-branch reconciler can share it onto its periodic tick without closing a
 * dependency cycle through this file. Existing importers keep working unchanged.
 */
export { reconcileSilentlyMergedWorkspaces } from "./silently-merged-reconciler.js";
import { reconcileSilentlyMergedWorkspaces } from "./silently-merged-reconciler.js";

/**
 * The startup work that MUST complete before the server may answer anything (#282).
 *
 * Deliberately short and git-free: kill a previous generation's process that may still
 * hold the DB, bring the schema up to date, assert FK enforcement, and settle the session
 * rows this process inherits. Everything else — every reconciler that spawns git per
 * worktree — is deferred to {@link runDeferredStartupTasks} and runs AFTER the listener
 * binds, because none of it is needed to render a board and all of it was being paid as
 * time-to-first-response (measured 238 s on this checkout, with ~65 worktrees).
 */
export async function runCriticalStartupTasks(sessionManager: SessionManager, _deps?: { agentService?: typeof agentServiceType }): Promise<void> {
  await killOrphanedServers();
  await runMigrations();
  await alignLiveDbForeignKeys();
  await cleanupStaleSessions(sessionManager);
}

/**
 * The deferred work that a MUTATING request must not overtake (#282).
 *
 * Everything here repairs state a write would otherwise act on: an unaborted merge or
 * rebase left by a hot-reload, a remote worker's push that landed while the board was down,
 * a workspace whose merge landed but whose close never did. Reads never wait for it; the
 * readiness gate holds writes until it resolves.
 *
 * Kept deliberately SHORT. It was originally the whole deferred phase, which on this
 * checkout runs for well over twenty minutes — long enough that every write spent the
 * gate's full 120 s ceiling before proceeding anyway, which is worse than the problem being
 * solved. The audit tail below has no ordering relationship to a write and must not gate one.
 */
export async function runGatedDeferredStartupTasks(): Promise<void> {
  await abortStaleMerges();
  await abortStaleRebases();
  try {
    // Worker fleet (epic #184): land any remote-worker pushes that arrived while
    // the board was down. Must run AFTER cleanupStaleSessions — that sweep
    // finalizes the pid-less remote session rows, and this recovers their work
    // from the incoming ref so a restart mid-flight does not lose it.
    const { sweepIncomingWorkerRefs } = await import("./worker-incoming-sweep.js");
    await sweepIncomingWorkerRefs();
  } catch (err) {
    console.warn("[startup] sweepIncomingWorkerRefs failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
  await reconcileSilentlyMergedWorkspaces();
}

/**
 * The long audit tail (#282): reconcilers and reaps that CONVERGE state rather than gate
 * it. Every entry is idempotent and has a periodic counterpart in BACKGROUND_SERVICES, so
 * a write racing one of them sees the same outcome a minute later either way — which is
 * why this runs ungated, with no request waiting on it.
 */
export async function runStartupAuditTasks(): Promise<void> {
  try {
    await reapOrphanedPluginViewProcesses();
  } catch (err) {
    console.warn("[startup] reapOrphanedPluginViewProcesses failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
  try {
    // Catch the orphans the DB does not know about (#281) — must run AFTER the
    // DB-tracked reap so a row's process is attributed to its row (and its command
    // line cross-checked) rather than being swept anonymously here.
    await reapParentlessChildServers();
  } catch (err) {
    console.warn("[startup] reapParentlessChildServers failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
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
    // #113: hand-merged `feature/ak-<N>` branches (dev fixes landed WITHOUT a board
    // workspace) have no workspace row to key off, so the linked issue #N never
    // auto-transitions. Scan each project's default-branch merge history and converge
    // still-open matching issues to Done. Idempotent; skips Backlog/terminal issues.
    await reconcileHandMergedBranches();
  } catch (err) {
    console.warn("[startup] reconcileHandMergedBranches failed (non-fatal):", err instanceof Error ? err.message : String(err));
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
  // #361: pruneStaleWorktrees above is DB-driven and can only see a closed workspace that still
  // has a workingDir — which a completed merge nulls. This runs the same sweep from GIT truth so a
  // worktree left behind by a merge (measured: kassenbuch `.worktrees/ak-6` and `ak-12`) is
  // recovered instead of blocking every later auto-merge on the project.
  await pruneOrphanedWorktrees();
  await checkMainCheckoutHeads();
}

/**
 * The full startup sequence: critical, then gated-deferred, then the audit tail.
 *
 * Retained for callers that genuinely want everything done before continuing (tests, and
 * any embedding that is not serving HTTP). `server-start.ts` does NOT use this — it runs
 * the phases around `serve()` on purpose.
 */
export async function runStartupTasks(sessionManager: SessionManager, deps?: { agentService?: typeof agentServiceType }): Promise<void> {
  await runCriticalStartupTasks(sessionManager, deps);
  await runGatedDeferredStartupTasks();
  await runStartupAuditTasks();
}
