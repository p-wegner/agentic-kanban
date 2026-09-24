// Types for repo-tree.mjs (#1241), so guard suites in any package can import the shared
// walker without `tsc` falling back to `any` (TS7016). Hand-written, matching the
// `promote-evidence.d.mts` convention: a suite EXECUTES the real module, so a declaration for
// an export that no longer exists fails at import time, not only at type-check time.
import type { Dirent } from "node:fs";

/** Directory names no repo-tree walk descends into, wherever they sit. */
export declare const REPO_TREE_SKIP_DIRS: ReadonlySet<string>;

/** `.claude/worktrees` — Claude Code's nested linked-worktree layout, skipped by name. */
export declare const NESTED_WORKTREES_DIR: string;

export interface WalkRepoTreeOptions {
  /** Directory names to skip IN ADDITION to {@link REPO_TREE_SKIP_DIRS}. */
  skipDirs?: Iterable<string>;
  /** Admit dot-prefixed directories and files (the root is never filtered). Default false. */
  includeDotfiles?: boolean;
  /** Keep only files whose name ends in one of these (with the dot). Default: every file. */
  extensions?: readonly string[];
  /** Final per-file predicate. */
  filter?: (absPath: string, entry: Dirent) => boolean;
  /** How many directory levels below the root to descend; `0` lists the root's files only. */
  maxDepth?: number;
}

/** Is `dir` a linked git worktree (its `.git` is a FILE)? */
export declare function isLinkedWorktreeDir(dir: string, entries?: readonly Dirent[]): boolean;

/** Every file under `root`, recursively, as sorted absolute paths; `[]` for a missing root. */
export declare function walkRepoTree(root: string, options?: WalkRepoTreeOptions): string[];

/** The immediate subdirectories of `root` a walk would descend into, as sorted absolute paths. */
export declare function listRepoSubdirs(
  root: string,
  options?: Pick<WalkRepoTreeOptions, "skipDirs" | "includeDotfiles">,
): string[];
