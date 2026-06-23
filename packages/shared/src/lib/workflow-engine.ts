/**
 * Workflow engine — the single source of truth for resolving an issue's
 * workflow template, tracking which node a workspace is on, validating
 * transitions, and keeping the legacy board `status` in sync.
 *
 * The implementation lives in cohesive modules under ./workflow-engine/:
 * pure policy (conditions, node-config, graph-validation, prompt, types) is
 * separated from the db-coupled I/O shell (engine). This file is a facade
 * barrel that preserves the public import surface
 * (@agentic-kanban/shared/lib/workflow-engine). Sub-modules import each other
 * directly (never this barrel) so the dependency graph stays acyclic.
 *
 * Edit the sub-modules, not this file.
 */
export * from "./workflow-engine/types.js";
export * from "./workflow-engine/conditions.js";
export * from "./workflow-engine/node-config.js";
export * from "./workflow-engine/graph-validation.js";
export * from "./workflow-engine/prompt.js";
export * from "./workflow-engine/engine.js";
