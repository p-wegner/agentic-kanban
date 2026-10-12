// Self-healing for a corrupt cached clone on a worker (#1417).
//
// A VM killed mid-write (host I/O hang) leaves zero-byte loose objects in the cached clone.
// Every later `git fetch` into it fails with `object file ... is empty`, so every assignment
// died in provisioning while the worker kept accepting work. The fix is to recognise the
// corruption signature, move the clone aside (never delete: retained undelivered results live
// on its `kanban/<sessionId>` branches) and let the caller re-clone once.

import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";

/** Prefix of the error thrown when the clone is still corrupt after the one re-clone. */
export const CLONE_UNHEALTHY_PREFIX = "worker clone unhealthy";

const CORRUPTION_SIGNATURES = [
  /object file .* is empty/i,
  /loose object .* is corrupt/i,
  /\bbad object\b/i,
  /\bcorrupt(ed)? (loose )?object/i,
  /unable to read [0-9a-f]{40}/i,
  /inflate: data stream error/i,
];

/** Does this git failure text name repository corruption (as opposed to auth / network)? */
export function isCloneCorruption(message: string): boolean {
  return CORRUPTION_SIGNATURES.some((re) => re.test(message));
}

/**
 * Move a corrupt cached clone to `<workRoot>/quarantine/<project>-<stamp>` so the next
 * provision re-clones. Outside `repos/` on purpose: the checkout reaper treats every
 * directory there as a live cache. Returns the new location.
 */
export function quarantineCorruptClone(workRoot: string, cacheDir: string, nowMs: number = Date.now()): string {
  const dir = join(workRoot, "quarantine");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${basename(cacheDir)}-${nowMs}`);
  renameSync(cacheDir, target);
  return target;
}

/** `git fsck --connectivity-only` of one clone: null when sound, else the trimmed complaint. */
export async function fsckClone(cacheDir: string): Promise<string | null> {
  const res = await gitExec(["fsck", "--connectivity-only", "--no-progress"], { cwd: cacheDir, timeout: 5 * 60 * 1000 });
  if (execSucceeded(res)) return null;
  return (res.stderr || res.stdout).trim().slice(-400) || "git fsck failed";
}

/** Cached clones under `<workRoot>/repos` that fail fsck: `{ project, problem }`. */
export async function findCorruptClones(workRoot: string): Promise<{ project: string; problem: string }[]> {
  const reposDir = join(workRoot, "repos");
  if (!existsSync(reposDir)) return [];
  const bad: { project: string; problem: string }[] = [];
  for (const e of readdirSync(reposDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const project = e.name;
    if (!existsSync(join(reposDir, project, ".git"))) continue;
    const problem = await fsckClone(join(reposDir, project));
    if (problem) bad.push({ project, problem });
  }
  return bad;
}
