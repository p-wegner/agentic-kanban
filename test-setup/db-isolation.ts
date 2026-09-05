/**
 * A test run may never inherit a DB-LOCATION override from the process that launched it (#231,
 * re-opened and closed again by #1041's gate).
 *
 * #231 gave `resolveDbLocation` a test-runner short-circuit: under vitest, with no explicit
 * override, every resolution goes to a per-process throwaway file so a module-load side effect
 * can never open the live board. That guard sits BELOW the env layer by design — "a test that
 * genuinely needs a specific DB must say so explicitly" — which is correct, and which is exactly
 * why an INHERITED override defeats it.
 *
 * And one is inherited. The board launches every agent session with
 * `KANBAN_DB_URL=file:<home>/.agentic-kanban/kanban.db`, so in a builder worktree the whole
 * server suite resolved the operated board database. Measured 2026-09-05: 13 failures — 5 in
 * `data-dir.test.ts` (which asserts this very precedence and cleared only #615's pre-rename
 * `DB_URL`), 5 in `backup.test.ts`, 1 in `startup-git-service-injection.test.ts` — plus the two
 * halves nobody would have noticed: `backup.test.ts` sets `DB_URL` to a temp file and had it
 * silently outranked, so `createBackup()`/the restore round-trip were operating on the LIVE
 * board rather than on the fixture they seeded.
 *
 * DELETED rather than blanked, because this runs in-process where a deletion is expressible
 * (the verify-gate half has to blank instead — a spread cannot delete; see
 * `packages/server/src/lib/verify-env.ts`). A test that wants a specific database still sets
 * `DB_URL`/`AGENTIC_KANBAN_DIR` in its own `beforeEach`, which runs after this and is unaffected.
 */
for (const key of ["KANBAN_DB_URL", "DB_URL"]) {
  delete process.env[key];
}
