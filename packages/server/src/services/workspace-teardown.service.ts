// Unified workspace teardown — runs on EVERY worktree-end path (merge, delete,
// fork-join cleanup) so leftover resources never accumulate (the "42 zombie dev
// servers" problem).
//
// Two layers, intentionally separated:
//
//  1. BUILT-IN, app-convention cleanup (best-effort, generic-safe):
//       - kill processes whose command line references the worktree dir, AND
//       - free the deterministic dev ports this app assigns to the worktree
//         (worktree dev servers resolve vite/tsx from the shared main-checkout
//         node_modules, so a dir-only match misses them).
//     This covers the app's own monorepo dev-server model out of the box.
//
//  2. GENERIC, project-configurable cleanup:
//       - run the project's teardownScript, with worktree context in the env.
//     This is the escape hatch for ANY other resource model — `docker compose down`,
//     remote sandboxes, named volumes, etc. The script — not hard-coded port logic —
//     is what makes arbitrary project types work.
//
// Ordering matters: kill/teardown BEFORE the caller removes the worktree, so nothing
// holds the directory open (which also fixes the EBUSY worktree-remove crash).

import { killProcessesInDir, killProcessesOnPorts } from "./process-cleanup.js";
import { runScript } from "./script-runner.js";
import { resolveWorktreeDevPorts } from "./worktree-ports.js";
import { auditProcessEvent, guardProcessKill } from "./process-guard.js";

/**
 * Best-effort kill of a process and its descendants by PID. Windows uses
 * `taskkill /T /F`; POSIX kills the process group then the bare PID. Guarded by
 * guardProcessKill so it never targets a protected/foreign PID. Generic OS teardown
 * primitive — lives here (the teardown service), not inside the CRUD service.
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (!pid || pid <= 0) return;
  if (!guardProcessKill(pid, { reason: "workspace-cleanup-fallback" })) return;
  if (process.platform === "win32") {
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve) => {
      const p = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      p.on("error", () => resolve());
      p.on("close", () => resolve());
    });
    auditProcessEvent({ action: "workspace-cleanup-taskkill-issued", pid });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
      auditProcessEvent({ action: "workspace-cleanup-sigkill-group-issued", pid });
    } catch {
      try {
        process.kill(pid, "SIGKILL");
        auditProcessEvent({ action: "workspace-cleanup-sigkill-issued", pid });
      } catch { /* already dead */ }
    }
  }
}

/**
 * Remove a directory recursively, retrying to ride out async Windows file-handle
 * release. Refuses to touch anything outside a managed `.worktrees` directory —
 * this is the ONLY containment check standing between a corrupt/legacy workspace
 * row (e.g. `workingDir` equal to the project's `repoPath`) and a recursive delete
 * of a real repo; callers gating on `!isDirect` are not sufficient on their own
 * (mirrors the guard in `removeLeftoverWorktreeDirectory`/`removeStaleWorktree`).
 */
export async function removeDirWithRetry(dir: string, attempts = 5, backoffMs = 300): Promise<boolean> {
  const { rm } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { resolve, sep } = await import("node:path");

  const resolved = resolve(dir);
  const segments = resolved.split(sep);
  const worktreesIndex = segments.lastIndexOf(".worktrees");
  if (worktreesIndex === -1 || worktreesIndex === segments.length - 1) {
    console.warn(`[workspaces] refusing to remove path outside a managed .worktrees directory: ${dir}`);
    return false;
  }

  for (let i = 0; i < attempts; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      if (!existsSync(dir)) return true;
    } catch (err) {
      if (i === attempts - 1) {
        console.warn(`[workspaces] directory removal failed after ${attempts} attempts: ${dir}`, err);
        return false;
      }
    }
    if (!existsSync(dir)) return true;
    await new Promise((resolve) => setTimeout(resolve, backoffMs * (i + 1)));
  }
  return !existsSync(dir);
}

export interface TeardownWorktreeParams {
  workingDir: string | null | undefined;
  branch?: string | null;
  isDirect?: boolean | null;
  /** Project's configurable teardown command (the generic mechanism). */
  teardownScript?: string | null;
  /** Project setup/teardown master switch (mirrors setup behaviour). */
  setupEnabled?: boolean | null;
  /** Short label for logs, e.g. "merge", "delete", "fork-join". */
  label: string;
}

export interface TeardownDeps {
  killDir?: (dir: string) => Promise<number>;
  killPorts?: (ports: number[]) => Promise<number>;
  runScript?: typeof runScript;
}

function issueNumberFromBranch(branch?: string | null): string | null {
  if (!branch) return null;
  const m = branch.match(/(?:^|[/_-])(?:ak-)?(\d+)-/i);
  return m ? m[1] : null;
}

/**
 * Tear down everything a workspace's worktree may have spun up. Best-effort and
 * non-throwing: a failure in one layer never blocks the others or the caller's
 * subsequent worktree removal. Returns counts for logging/observability.
 */
export async function teardownWorktree(
  params: TeardownWorktreeParams,
  deps: TeardownDeps = {},
): Promise<{ killedInDir: number; killedOnPorts: number; scriptRan: boolean }> {
  const { workingDir, branch, isDirect, teardownScript, setupEnabled, label } = params;
  const result = { killedInDir: 0, killedOnPorts: 0, scriptRan: false };

  // Direct workspaces operate in the project's main repo, not a throwaway worktree —
  // never kill processes or run teardown against the shared checkout.
  if (!workingDir || isDirect) return result;

  const killDir = deps.killDir ?? killProcessesInDir;
  const killPorts = deps.killPorts ?? killProcessesOnPorts;
  const run = deps.runScript ?? runScript;

  // Layer 1a — processes whose command line references the worktree dir.
  try {
    result.killedInDir = await killDir(workingDir);
  } catch (err) {
    console.warn(`[teardown:${label}] dir cleanup failed (non-fatal):`, err instanceof Error ? err.message : String(err));
  }

  // Layer 1b — free the app-convention dev ports for this worktree (exact ports only).
  const ports = resolveWorktreeDevPorts(workingDir);
  if (ports) {
    try {
      result.killedOnPorts = await killPorts([ports.serverPort, ports.clientPort]);
    } catch (err) {
      console.warn(`[teardown:${label}] port cleanup failed (non-fatal):`, err instanceof Error ? err.message : String(err));
    }
  }

  // Layer 2 — generic project teardownScript with worktree context in the env.
  if (teardownScript && setupEnabled !== false) {
    const env: Record<string, string> = { KANBAN_WORKTREE_DIR: workingDir };
    if (branch) env.KANBAN_WORKTREE_BRANCH = branch;
    const issueNumber = issueNumberFromBranch(branch);
    if (issueNumber) env.KANBAN_ISSUE_NUMBER = issueNumber;
    if (ports) {
      env.KANBAN_WORKTREE_SERVER_PORT = String(ports.serverPort);
      env.KANBAN_WORKTREE_CLIENT_PORT = String(ports.clientPort);
    }
    try {
      const r = await run(teardownScript, workingDir, `teardown:${label}`, env);
      result.scriptRan = true;
      console.log(`[teardown:${label}] script ${r.ok ? "ok" : "failed"} — ${r.output.slice(0, 100)}`);
    } catch (err) {
      console.warn(`[teardown:${label}] script threw (non-fatal):`, err instanceof Error ? err.message : String(err));
    }
  }

  if (result.killedInDir || result.killedOnPorts) {
    console.log(`[teardown:${label}] freed ${result.killedInDir} dir proc(s), ${result.killedOnPorts} port owner(s) in ${workingDir}`);
  }
  return result;
}
