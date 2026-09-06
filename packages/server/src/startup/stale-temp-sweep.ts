/**
 * Reap throwaway `%TEMP%` directories whose owner never got to remove them (#1050).
 *
 * `sweepStaleTempDirs` is the recovery mechanism `shared/lib/temp-dir.ts`'s own header
 * presents as the answer to the 8,448 leaked directories of #362/#364 — and until this
 * module it had ZERO production callers: it existed, it was tested, and nothing ever ran
 * it. That gap is not cosmetic, because the owner deliberately registers no exit hook (an
 * exit hook cannot run on SIGKILL and would hide a leak until teardown), so a directory
 * whose owner was killed had nothing left to remove it, ever.
 *
 * Measured 2026-09-05: two orphaned base-health probe roots in `%TEMP%`, each a full repo
 * clone plus its installed `node_modules` (1813 in-tree links), on a box whose very next
 * probe then died with `pnpm install` exit 0xC0000005 for want of memory. A silent leak
 * that makes the next run likelier to fail, and leak again, is a ratchet.
 *
 * Namespace-wide on purpose: every prefix this codebase owns starts with `kanban-`
 * (enforced by `assertNamespacedPrefix`), so one call covers the prefixes that exist today
 * AND the ones added later — a per-prefix list is the drift that produced the original
 * backlog. Ownership, not age, protects live work. Legacy roots without ownership are
 * retained: an older stable board may still be using them. They need an operator cleanup.
 */
import { sweepStaleTempDirsAsync, TEMP_DIR_NAMESPACE } from "@agentic-kanban/shared/lib/temp-dir";
import type { SweepTempDirsResult } from "@agentic-kanban/shared/lib/temp-dir";

export type StaleTempSweepResult = SweepTempDirsResult;

/**
 * Idempotent and safe to run at every boot: `sweepStaleTempDirs` never throws, skips
 * anything younger than the grace period, and caps its own removals per pass (a truncated
 * sweep simply continues next boot).
 */
export async function sweepStaleTempDirsOnce(
  options: { root?: string; nowMs?: number; olderThanMs?: number } = {},
  log: (message: string) => void = console.log,
): Promise<StaleTempSweepResult> {
  const result = await sweepStaleTempDirsAsync(TEMP_DIR_NAMESPACE, { ...options, retainUnowned: true });
  // Silent on a clean boot — the common case, and a line saying "0 removed" every start is
  // how a log stops being read. Anything else is reported, INCLUDING failures: the whole
  // point of the ticket is that a leak nobody can see is a leak nobody fixes.
  if (result.removed > 0 || result.failed > 0) {
    log(
      `[startup] temp sweep: ${result.removed} removed, ${result.failed} failed, ${result.matched} matched` +
        (result.truncated ? " (truncated — more remain, next boot continues)" : ""),
    );
  }
  return result;
}
