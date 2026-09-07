/**
 * `check:arch`'s scoping is a DIFFERENT axis from the test-tier scoping in `buildVerifyEnv`
 * (#1052) — it needs the diff regardless of `guardsOnly`/`packagesEnv`/`emitFileScope`, all of
 * which are about `test:mine`'s half of the verify script. Split into its own module so
 * `pre-merge-gate-tier.ts` (already once split for the same reason, see its own header) doesn't
 * grow past the god-module ceiling for a two-line addition.
 *
 * `[]` (unreadable diff) yields `{}`, and `scripts/check-arch.mjs` treats an unset
 * `KANBAN_ARCH_CHANGED_FILES` as "run everything" — the same fail-open direction every other
 * precondition in this gate uses.
 */
export function archVerifyEnv(changedFiles: readonly string[]): Record<string, string> {
  return changedFiles.length > 0 ? { KANBAN_ARCH_CHANGED_FILES: changedFiles.join(",") } : {};
}
