import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

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
 * different homes.
 *
 * Deliberately kept OUTSIDE the worktree itself (under the OS temp dir), matching
 * the existing "Go's module cache / Gradle's caches live outside the tree"
 * assumption `container-dep-volumes.ts` already relies on: for a containerized
 * builder the worktree is a bind mount (rename-flake-prone on Windows, #138), so a
 * multi-GB Gradle cache+daemon registry belongs off that mount, not on it.
 */
export function gradleUserHomeForWorktree(worktreePath: string): string {
  const slug = createHash("sha1").update(worktreePath).digest("hex").slice(0, 12);
  return join(tmpdir(), "kanban-gradle-homes", `${basename(worktreePath)}-${slug}`);
}
