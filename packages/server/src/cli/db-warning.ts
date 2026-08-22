import { existsSync as fsExistsSync, statSync as fsStatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Split-brain warning (#112) for a CLI subcommand that resolved to the
 * home-fallback DB (~/.agentic-kanban/kanban.db).
 *
 * #733 — this used to fire on EVERY invocation whose resolution was
 * `home-fallback`, and it asserted a hypothetical ("this CLI may be
 * reading/writing a DIFFERENT database than the running server") as though it
 * were the current condition. In a checkout with no `packages/server/kanban.db`
 * the home path IS the only database — the one the dev server serves — so the
 * warning was simply false, and being unconditional and authoritative it talked
 * two careful agents out of correct ticket writes in one session.
 *
 * The resolver decides by file existence, so the CLI can tell the three cases
 * apart. It now warns only about the thing it warns about:
 *
 *   1. checkout DB ABSENT, main checkout → no divergence exists. Say nothing.
 *      (`db/index.ts` already logs the resolved path/source on stderr, which is
 *      the one informational line this case warrants.)
 *   2. checkout DB PRESENT and not the resolved path → the case the original
 *      text was written for. Warn, naming BOTH paths and why the checkout file
 *      was not adopted.
 *   3. checkout DB absent, but we are in a WORKTREE → a dev server started from
 *      another checkout may have its own in-checkout DB. Informational, and it
 *      says the checkout-local file is ABSENT rather than implying it is in use.
 *
 * Pure (state is passed in) so it is unit-testable without executing the CLI,
 * which parses argv on import.
 *
 * Emitted via `console.warn`, i.e. on stderr — never stdout, so it cannot
 * corrupt `--json` output.
 */
export type CheckoutDbState =
  /** A checkout-local kanban.db exists on disk but is not what got resolved. */
  | { kind: "present"; path: string; rejectedAsInvalid: boolean }
  /** No checkout-local kanban.db exists. `isWorktree` picks case 1 vs case 3. */
  | { kind: "absent"; isWorktree: boolean };

export interface DbLocationLike {
  source: string;
  path: string | null;
  url: string;
}

/**
 * Classify the checkout side of the resolution from the resolver's own candidate
 * list, so the warning text is derived from disk rather than assumed.
 * `rejectedLocalCandidates` (from `resolveDbLocation`) records candidates that
 * exist but were rejected as stubs / migrated-but-empty leftovers.
 */
export function probeCheckoutDb(
  candidates: readonly string[],
  opts: {
    resolvedPath?: string | null;
    rejectedLocalCandidates?: readonly string[];
    existsSync?: (p: string) => boolean;
    isFile?: (p: string) => boolean;
  } = {},
): CheckoutDbState {
  const exists = opts.existsSync ?? fsExistsSync;
  const rejected = new Set((opts.rejectedLocalCandidates ?? []).map((p) => resolve(p)));
  for (const candidate of candidates) {
    if (resolve(candidate) === resolve(opts.resolvedPath ?? "")) continue;
    if (!exists(candidate)) continue;
    return { kind: "present", path: candidate, rejectedAsInvalid: rejected.has(resolve(candidate)) };
  }
  return { kind: "absent", isWorktree: isWorktreeCheckout(candidates, opts) };
}

/**
 * A linked git worktree's `.git` is a FILE (a gitdir pointer); a main checkout's
 * is a directory. Walk up from the candidate's directory to the first `.git` and
 * report which one it is. No `git` spawn — this runs on every CLI invocation.
 */
export function isWorktreeCheckout(
  candidates: readonly string[],
  opts: { existsSync?: (p: string) => boolean; isFile?: (p: string) => boolean } = {},
): boolean {
  const exists = opts.existsSync ?? fsExistsSync;
  const isFile =
    opts.isFile ??
    ((p: string) => {
      try {
        return fsStatSync(p).isFile();
      } catch {
        return false;
      }
    });
  for (const candidate of candidates) {
    let dir = dirname(resolve(candidate));
    for (;;) {
      const dotGit = join(dir, ".git");
      if (exists(dotGit)) return isFile(dotGit);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return false;
}

const PIN_HINT = `  Pin both to one database with AGENTIC_KANBAN_DIR (a data dir) or KANBAN_DB_URL.`;

export function homeFallbackDbWarning(
  loc: DbLocationLike,
  checkout: CheckoutDbState = { kind: "absent", isWorktree: false },
): string | null {
  if (loc.source !== "home-fallback") return null;
  const inUse = loc.path ?? loc.url;

  if (checkout.kind === "present") {
    const why = checkout.rejectedAsInvalid
      ? `exists, but was rejected as not a real board (empty or too small)`
      : `exists, and is NOT the database in use`;
    return (
      `⚠ agentic-kanban CLI is using the home-fallback database, not the one in this checkout:\n` +
      `    in use:   ${inUse}  (source: home-fallback)\n` +
      `    checkout: ${checkout.path}  (${why})\n` +
      `  Another tool — or an older server build — that adopts the checkout file on presence\n` +
      `  alone is reading/writing a DIFFERENT database than this CLI.\n` +
      PIN_HINT
    );
  }

  if (checkout.isWorktree) {
    return (
      `ℹ agentic-kanban CLI is using the home database: ${inUse}\n` +
      `  This worktree has no checkout-local packages/server/kanban.db (absent, not shadowed),\n` +
      `  so that home file is the database in use. A dev server started from a DIFFERENT\n` +
      `  checkout that does have one would use that file instead.\n` +
      PIN_HINT
    );
  }

  // No checkout-local kanban.db exists: the home path is the only database there
  // is, so there is nothing to warn about. db/index.ts already logs it (stderr).
  return null;
}
