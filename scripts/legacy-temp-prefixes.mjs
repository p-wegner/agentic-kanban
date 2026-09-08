/**
 * DERIVE which un-namespaced `%TEMP%` prefixes this repo is responsible for (#1056 follow-up).
 *
 * The fixture reaper and `sweep-temp-dirs.mjs` only know `kanban-`/`ak-`, so every directory
 * minted before a suite was renamed into that namespace is unreachable by anything and stays on
 * disk forever. Measured on the authoring box: **22,704 such directories**, ~25 % of `%TEMP%`,
 * in prefixes like `smoke-srv-`, `cli-test-`, `compounding-setup-`, `preflight-test-`.
 *
 * The obvious fix — add those prefixes to `NAMESPACES` — was rejected: an un-namespaced prefix is
 * by definition one nobody owns, several plausibly belong to SIBLING tools on the same machine
 * (refactor-skill, code-metrics), and a board script deleting another tool's temp dirs is
 * overreach. A hand-written list would also be exactly the "list of known offenders" that
 * `temp-dir-namespace-guard.test.ts`'s header says cannot work.
 *
 * **So ownership is derived rather than asserted.** For every `ak-<X>-` prefix THIS repo currently
 * mints under `tmpdir()`, the bare `<X>-` form in `%TEMP%` was minted by an older revision of that
 * same call site. That is a provable claim about our own history, not a guess about a name — and
 * it is self-maintaining: rename a fixture prefix and its legacy form is covered automatically;
 * delete the suite and the claim disappears with it.
 *
 * Three narrowings, each closing a way the derivation could over-reach:
 *
 * 1. **Specific prefixes only.** `ak-plan-`, `ak-ws-`, `ak-fork-`, `ak-guard-`, `ak-bisect-` yield
 *    bare forms common enough to belong to anyone, so a prefix must contain a hyphen or be at
 *    least `MIN_GENERIC_LENGTH` characters. This also drops the numeric fragments that fall out of
 *    ticket-scoped names (`ak-1027-worktree-` -> `1027`), which would otherwise match any
 *    directory starting with a number.
 * 2. **Directories only**, never files — `kanban-session-*.out` transcripts are read by the live
 *    server, and the same reasoning applies to anything else a running process is writing.
 * 3. **The caller's age cutoff still applies.** A concurrently running suite, in this checkout or
 *    another worktree, is never touched.
 *
 * Deliberately NOT exported into `NAMESPACES`: this is a one-off backlog drain behind an explicit
 * `--legacy` flag, not a steady-state sweep. The steady state is already correct — every one of
 * these call sites mints `ak-*` today, which is why their bare forms are historical at all.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "coverage", "test-results", "playwright-report", "drizzle", ".worktrees",
]);
const SOURCE_EXT = /\.(ts|tsx|mjs|cjs|js)$/;

/** A bare prefix shorter than this, with no hyphen, is too common to claim. */
export const MIN_GENERIC_LENGTH = 8;

/** `"ak-smoke-srv-"` / `` `ak-thing-${id}` `` — the leading literal is what names the namespace. */
const AK_PREFIX = /["'`]ak-([A-Za-z0-9][A-Za-z0-9._-]*?)-?["'`]/g;

/** Is this bare prefix specific enough to be claimed as ours? */
export function isClaimablePrefix(prefix) {
  if (!prefix) return false;
  // A purely numeric fragment is never a name — it fell out of `ak-<ticket>-something`.
  if (/^\d+$/.test(prefix)) return false;
  return prefix.includes("-") || prefix.length >= MIN_GENERIC_LENGTH;
}

/** Every source file that could mint a temp dir. */
function sourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      // A junction reports as a symlink, never a directory (plugin skills are junctioned in).
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) walk(full);
      else if (SOURCE_EXT.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * The bare prefixes this repo can prove it minted, from the `ak-` names it mints today.
 * Returns `{ claimable, rejected }` so a caller can SHOW what it declined to claim — a derivation
 * that silently narrows is one nobody can check.
 */
export function deriveLegacyPrefixes(root) {
  const seen = new Set();
  for (const file of sourceFiles(root)) {
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Only files that actually reach the temp dir; `ak-` appears in branch names and ids too.
    if (!src.includes("tmpdir")) continue;
    for (const match of src.matchAll(AK_PREFIX)) seen.add(match[1]);
  }
  const claimable = [...seen].filter(isClaimablePrefix).sort();
  const rejected = [...seen].filter((p) => !isClaimablePrefix(p)).sort();
  return { claimable, rejected };
}

/** Does this entry name belong to one of the derived prefixes? Returns the prefix, or null. */
export function matchLegacyPrefix(name, prefixes) {
  // Both separators: `mkdtemp` appends random characters directly, and older call sites used
  // either form (`smoke-srv-00QDjs`, `impres_000abjgx`).
  return prefixes.find((p) => name.startsWith(`${p}-`) || name.startsWith(`${p}_`)) ?? null;
}
