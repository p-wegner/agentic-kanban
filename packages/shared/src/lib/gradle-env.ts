import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { errorMessage } from "./error-message.js";

/** Root that holds every per-worktree Gradle home, so the set is sweepable as a unit. */
export const GRADLE_HOMES_ROOT = join(tmpdir(), "kanban-gradle-homes");

/**
 * Canonical form of a worktree path for KEYING purposes.
 *
 * The key must be stable across the spellings of the same directory that different
 * call sites produce — `C:\repo\.worktrees\ak-1` (a DB `workingDir`), the same path
 * with forward slashes, a trailing separator, `.` segments, or a different drive-letter
 * case. Hashing the raw string made each of those a DIFFERENT Gradle home, which
 * silently defeats the whole point of the function: the builder's own `gradlew` and the
 * backend's verify/smoke gradle for the SAME worktree are meant to share one daemon,
 * and instead each spelling forked its own multi-GB cache and daemon registry.
 *
 * `resolve` normalises separators, `.`/`..` and trailing slashes. Case is folded only
 * on win32, where the filesystem is case-insensitive — folding on POSIX would collide
 * two genuinely different worktrees.
 */
function worktreeKey(worktreePath: string): string {
  const abs = resolve(worktreePath);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * Deterministic per-worktree Gradle user home (#194).
 *
 * The board used to leave `GRADLE_USER_HOME` unset everywhere, so every worktree's
 * `gradlew` (both the builder's own invocations and the backend's verify/smoke/
 * cold-clone gradle) landed in the SAME default `~/.gradle` — one shared daemon
 * registry, one shared `in-progress-results-*.bin` set. Two builders in different
 * worktrees building concurrently would then fight over the same daemon pool, and
 * `gradle --stop` (or a daemon dying) in one worktree could kill the daemon another
 * worktree was mid-build with — surfacing as "N busy and N stopped Daemons could not
 * be reused".
 *
 * Keying this off the worktree path (rather than a session/workspace id) means the
 * builder's own `gradlew` calls and any backend-spawned gradle running against the
 * SAME worktree (verify gate, smoke check) resolve to the SAME home — they are
 * meant to share a daemon — while two DIFFERENT worktrees always resolve to
 * different homes. See `worktreeKey` for why the path is normalised first.
 *
 * Deliberately kept OUTSIDE the worktree itself (under the OS temp dir), matching
 * the existing "Go's module cache / Gradle's caches live outside the tree"
 * assumption `container-dep-volumes.ts` already relies on: for a containerized
 * builder the worktree is a bind mount (rename-flake-prone on Windows, #138), so a
 * multi-GB Gradle cache+daemon registry belongs off that mount, not on it.
 *
 * Because it lives outside the worktree, removing the worktree does NOT remove it —
 * call {@link removeGradleUserHomeForWorktree} on teardown, or these directories
 * accumulate one multi-GB cache per worktree that ever built, forever.
 */
export function gradleUserHomeForWorktree(worktreePath: string): string {
  // BOTH parts derive from the normalised key. Taking the readable prefix from the raw
  // path instead would reintroduce the bug it fixes on win32: two case-spellings of one
  // directory would hash the same but land in differently-named directories.
  const key = worktreeKey(worktreePath);
  const slug = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return join(GRADLE_HOMES_ROOT, `${basename(key)}-${slug}`);
}

/**
 * Delete a worktree's Gradle home. Best-effort and never throws: a Gradle daemon may
 * still hold a lock file open (Windows EBUSY), and failing to reclaim disk must never
 * fail a teardown. Returns whether the directory is gone.
 *
 * Only ever removes a path under {@link GRADLE_HOMES_ROOT} — the containment check
 * matters because this is a recursive delete driven by a DB-supplied `workingDir`.
 */
export async function removeGradleUserHomeForWorktree(worktreePath: string): Promise<boolean> {
  const target = gradleUserHomeForWorktree(worktreePath);
  if (!target.startsWith(GRADLE_HOMES_ROOT + sep)) return false;
  const { rm, stat } = await import("node:fs/promises");
  try {
    await stat(target);
  } catch {
    return true; // nothing there — the desired end state
  }
  try {
    await rm(target, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.warn(`[gradle-env] could not remove ${target} (non-fatal):`, errorMessage(err));
    return false;
  }
}
