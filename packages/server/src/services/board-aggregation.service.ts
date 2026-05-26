// Facade: re-exports all board aggregation concerns from domain-focused services.
// Import directly from the sub-services for better tree-shaking and clarity.
export type { WorkspaceSummary } from "./workspace-summary.service.js";
export { buildWorkspaceSummaryMap } from "./workspace-summary.service.js";
export { enrichWorkspacesWithSessionData } from "./session-stats.service.js";
export { buildBlockedMap, buildTagMap, buildGraphEdges, wouldCreateCycle } from "./board-column.service.js";
export type { GraphEdge } from "./board-column.service.js";
export { parseDiffStats } from "./diff-stats.service.js";
