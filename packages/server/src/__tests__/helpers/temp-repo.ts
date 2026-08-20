import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A real on-disk repo path for tests that reach the REAL repo-lock / merge path (#273).
 *
 * Seeding a project with `repoPath: "/repo"` looks harmless and is not: `tryAcquireRepoLock`
 * refuses a repoPath with no `.git` and then POLLS, so every test that drives the actual
 * merge path against that literal burns its full timeout instead of failing. Two suites
 * (#264, #221) only ever passed because an earlier run had leaked a real `C:\repo\.git` onto
 * the dev machine; once that was removed, 45 tests across 8 files went red at once — they
 * had been latent hangs on any clean machine and in CI all along.
 *
 * The directory is a temp dir with a `.git` inside — enough for the lock to accept it, with
 * no `git init` cost. Suites that never reach the lock (git service fully mocked) do not
 * need this; the literal is only a trap where the real path is reachable.
 *
 * Cleanup: call {@link cleanupTempRepos} from `afterAll`. A process-exit sweep runs anyway,
 * so a suite that forgets leaks nothing beyond its own run.
 */
const created: string[] = [];
let exitHookInstalled = false;

export function makeTempRepo(label = "kanban-test-repo"): string {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  // The lock's liveness check is "does this path have a .git?" — a directory satisfies it.
  mkdirSync(join(dir, ".git"), { recursive: true });
  created.push(dir);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => cleanupTempRepos());
  }
  return dir;
}

/** Remove every repo made by {@link makeTempRepo} in this worker. Safe to call twice. */
export function cleanupTempRepos(): void {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A Windows handle still open on a temp dir is not worth failing a suite over.
    }
  }
}
