/**
 * The ONE repo-tree walker (#1241).
 *
 * The repo had ~73 files with a private `readdirSync` walker — every guard suite that asserts a
 * property of the whole tree, most `scripts/*.mjs` — each with a hand-kept skip set
 * (`node_modules`, `.git`, `dist`, `.worktrees`, …). None of them knew about nested LINKED
 * worktrees: Claude Code's `.claude/worktrees/<name>` layout puts whole second copies of the
 * source tree under the main checkout, so each walker walked N trees instead of one. Measured
 * 2026-09-24 with five of them in place: `legacy-temp-prefixes.test.ts` walked six source trees
 * and timed out at its 300 s budget; with the "skip a directory whose `.git` is a FILE" rule
 * the same guard takes 10.8 s. The #1033 `node_modules` wipe was the same class of miss
 * (`dev-supervisor.mjs` did not exclude `.claude`).
 *
 * Three rules every walk gets, without having to know them:
 *   1. The canonical skip set ({@link REPO_TREE_SKIP_DIRS}) — build output, dependency stores,
 *      caches, reports, and the sibling-worktree directory `.worktrees`.
 *   2. A directory whose `.git` is a FILE is a linked worktree: a second copy of the tree, never
 *      descended (the root itself is exempt — a walk rooted IN a linked worktree is the common
 *      case for a builder). `.claude/worktrees` is also skipped by NAME, belt and braces, so an
 *      empty or half-provisioned worktree dir costs nothing either.
 *   3. A symlink is never followed. On Windows a junction reports as a symlink, never as a
 *      directory (plugin skills are junctioned into `.claude/skills/`), and following one is
 *      how a walk escapes the tree it was asked about.
 *
 * Plain ESM with no dependencies, importable from `node scripts/x.mjs` and from any package's
 * vitest suite (`../../../../scripts/lib/repo-tree.mjs`); `repo-tree.d.mts` beside it carries
 * the types. `private-tree-walker-ratchet.test.ts` (shared) pins the set of files still
 * carrying a private walker, shrink-only.
 */
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Directory NAMES no repo-tree walk descends into, wherever they sit. The union of every
 * hand-kept skip set this replaced (`dev-supervisor.mjs`'s `IGNORED_DIRS`, the guard suites',
 * `legacy-temp-prefixes.mjs`'s).
 */
export const REPO_TREE_SKIP_DIRS = Object.freeze(
  new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage",
    "target",
    ".turbo",
    ".vite",
    "test-results",
    "playwright-report",
    ".worktrees",
  ]),
);

/** The nested-linked-worktree directory Claude Code's EnterWorktree layout uses: `<main>/.claude/worktrees/<name>`. */
export const NESTED_WORKTREES_DIR = ".claude/worktrees";

/**
 * Is `dir` a linked git worktree, i.e. a directory whose `.git` is a FILE (`gitdir: …`)
 * rather than the repository directory? Decided from the directory's own listing so it costs
 * no extra `stat`; pass the entries if you already have them.
 */
export function isLinkedWorktreeDir(dir, entries) {
  const list = entries ?? safeReaddir(dir);
  return list.some((e) => e.name === ".git" && e.isFile());
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function resolveOptions(options) {
  const skipDirs = new Set(REPO_TREE_SKIP_DIRS);
  for (const name of options.skipDirs ?? []) skipDirs.add(name);
  const extensions = options.extensions ?? null;
  return {
    skipDirs,
    includeDotfiles: options.includeDotfiles ?? false,
    filter: options.filter ?? null,
    extensions,
    maxDepth: options.maxDepth ?? Infinity,
  };
}

/**
 * Every file under `root`, recursively, as absolute paths in a deterministic (sorted) order.
 * A missing or unreadable directory yields nothing rather than throwing: a guard that scans
 * several roots must not die on the one a checkout happens not to have.
 *
 * `options.skipDirs` EXTENDS the canonical set (it cannot remove from it). `includeDotfiles`
 * (default false) admits dot-prefixed directories and files other than the canonical skips —
 * a walk rooted AT a dot-directory (`.claude/hooks`) always lists it, since the root is never
 * filtered. `extensions` keeps only files ending in one of them (with the dot); `filter` is a
 * final per-file predicate; `maxDepth: 0` lists the root's own files only.
 */
export function walkRepoTree(root, options = {}) {
  const opts = resolveOptions(options);
  const out = [];
  const visit = (dir, depth) => {
    const entries = safeReaddir(dir);
    // Rule 2: a linked worktree below the root is a second copy of the tree.
    if (depth > 0 && isLinkedWorktreeDir(dir, entries)) return;
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const name = entry.name;
      // Rule 3: never follow a symlink or junction, in either direction.
      if (entry.isSymbolicLink()) continue;
      if (!opts.includeDotfiles && name.startsWith(".")) continue;
      const full = join(dir, name);
      if (entry.isDirectory()) {
        if (opts.skipDirs.has(name)) continue;
        if (name === "worktrees" && basename(dir) === ".claude") continue;
        if (depth < opts.maxDepth) visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (opts.extensions && !opts.extensions.some((ext) => name.endsWith(ext))) continue;
      if (opts.filter && !opts.filter(full, entry)) continue;
      out.push(full);
    }
  };
  visit(root, 0);
  return out;
}

/**
 * The immediate subdirectories of `root` that a repo-tree walk would descend into — the same
 * skip, worktree and symlink rules as {@link walkRepoTree}, one level only. For the flat
 * `readdirSync(PACKAGES_ROOT)` idiom that lists packages before walking each one.
 */
export function listRepoSubdirs(root, options = {}) {
  const opts = resolveOptions(options);
  const out = [];
  for (const entry of safeReaddir(root)) {
    const name = entry.name;
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    if (!opts.includeDotfiles && name.startsWith(".")) continue;
    if (opts.skipDirs.has(name)) continue;
    if (name === "worktrees" && basename(root) === ".claude") continue;
    const full = join(root, name);
    if (isLinkedWorktreeDir(full)) continue;
    out.push(full);
  }
  return out.sort();
}
