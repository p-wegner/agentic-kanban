/**
 * High-level git operations — the single source of truth for the whole app.
 * The implementation lives in cohesive modules under ./git-service/; this file
 * is a facade barrel that preserves the public import surface
 * (@agentic-kanban/shared/lib/git-service). Sub-modules import each other
 * directly (never this barrel) so the dependency graph stays acyclic.
 *
 * Edit the sub-modules, not this file. Server and mcp-server re-export from here.
 *
 * These are `export *` (VALUE) re-exports, not `export type *`: the sub-modules
 * export runtime git functions that import node:child_process/fs/path. That is the
 * #791 client-white-screen shape — but it is SAFE here because this barrel is
 * reachable only via its deep path (@agentic-kanban/shared/lib/git-service) and is
 * NOT re-exported through lib/index.ts, so the client bundle never reaches it.
 * `barrel-client-safety.test.ts` (#875) enforces that invariant: it fails if this
 * (or any node-only deep-path barrel) ever leaks into the client-reachable graph.
 * Do NOT add this file to lib/index.ts.
 */
export * from "./git-service/worktree.js";
export * from "./git-service/branch-attach.js";
export * from "./git-service/branch.js";
export * from "./git-service/diff.js";
export * from "./git-service/conflict.js";
export * from "./git-service/merge.js";
export * from "./git-service/rebase.js";
export * from "./git-service/history.js";
export * from "./git-service/migration-renumber.js";
