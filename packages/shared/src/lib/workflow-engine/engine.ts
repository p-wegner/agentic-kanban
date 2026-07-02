/**
 * Workflow engine — the db-coupled I/O shell, decomposed by responsibility.
 *
 * #875 split the former 688-line god-module into cohesive sibling modules, one
 * per responsibility, re-exported here so the public import surface
 * (@agentic-kanban/shared/lib/workflow-engine, via ../workflow-engine.js) is
 * unchanged. The siblings import each other directly (never this barrel) so the
 * dependency graph stays acyclic — edit them, not this file:
 *
 *  - status-resolution.ts — resolveStatusId (shared leaf helper)
 *  - node-queries.ts       — getStartNode / getNode / getOutgoingTransitions /
 *                            countNodeVisits / findJoinNode
 *  - templates.ts          — template CRUD + resolveTemplateForIssue + graph I/O
 *  - transitions.ts        — computeWorkspaceSignals / proposeTransition /
 *                            placeWorkspaceOnNode (+ ProposeResult)
 *  - status-sync.ts        — syncCurrentNodeToStatus
 *  - status-transition.ts  — transitionIssueStatus (#953 single write authority)
 *  - workspace-init.ts     — resolveWorkflowStart / initWorkspaceWorkflow
 */
export * from "./node-queries.js";
export * from "./templates.js";
export * from "./transitions.js";
export * from "./status-sync.js";
export * from "./status-transition.js";
export * from "./workspace-init.js";
