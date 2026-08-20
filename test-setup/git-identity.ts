/**
 * Git committer identity for every test in every package (#285).
 *
 * Real-git fixtures used to set this per repo with two `git config` calls — 164 of them across
 * 49 suites. Those are pure process launches doing no work, and a process launch is not free:
 * on the dev box this was measured on, `git --version` (which does nothing at all) costs
 * 0.75-3.1 s because an unsigned `git.exe` under a user profile is re-scanned by the AV on
 * every exec, while `cmd /c exit` costs 0.2 s (#284). At that price the config calls alone were
 * minutes of every full run, and they are a large part of why the "#173 family" of suites is
 * green in isolation but times out under parallelism.
 *
 * Env is strictly better than repo-local config here, beyond the cost:
 *  - it needs no process launch at all;
 *  - it applies to WORKTREES, submodules and clones automatically, where repo-local config
 *    only applies if inheritance happens to reach them — several suites commit inside
 *    worktrees and relied on that;
 *  - it cannot be forgotten by the next fixture someone writes.
 *
 * Only set when absent, so a test that deliberately exercises a different identity (or a CI
 * runner that pins one) still wins.
 *
 * NOT set here: `commit.gpgsign=false`. Three suites set it per repo on purpose, and signing
 * is a machine-level concern a global default should not silently override.
 */
const GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

for (const [key, value] of Object.entries(GIT_IDENTITY)) {
  if (!process.env[key]) process.env[key] = value;
}
