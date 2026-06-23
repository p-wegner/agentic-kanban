/**
 * Thin re-export of the shared dependency-graph primitives.
 *
 * The pure cycle-detection logic is the single source of truth in
 * `@agentic-kanban/shared/lib/dependency-graph` so the server and mcp-server can
 * not drift (mcp's `add_dependency` tool previously hand-rolled its own DFS).
 * Edit the shared module, not this file.
 */
export * from "@agentic-kanban/shared/lib/dependency-graph.js";
