/**
 * High-level git operations — the single source of truth for the whole app.
 * The implementation lives in cohesive modules under ./git-service/; this file
 * is a facade barrel that preserves the public import surface
 * (@agentic-kanban/shared/lib/git-service). Sub-modules import each other
 * directly (never this barrel) so the dependency graph stays acyclic.
 *
 * Edit the sub-modules, not this file. Server and mcp-server re-export from here.
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
