// Facade barrel (#889 / #913). workspace.repository.ts was a 23-declaration
// low-cohesion god-module (over the 20 top-level-declaration ceiling). It is now
// split by RESPONSIBILITY into cohesive sub-modules, re-exported here so every
// existing `from "../repositories/workspace.repository.js"` importer keeps working
// unchanged. Re-exports carry no behavioral surface, so this barrel scores 0 on
// the god-module gate. Add new workspace-repository functions to the appropriate
// sub-module (and re-export them here) rather than growing this file back.
//
//   workspace-reads.repository.ts             — single/list reads + details projection
//   workspace-mutations.repository.ts         — status update + cascade delete
//   workspace-analytics.repository.ts         — dashboard aggregation-source reads
//   workspace-project-resolution.repository.ts — workspace → project / repo / id
//   workspace-issue-status.repository.ts      — move the workspace's issue between statuses

export {
  getWorkspaceById,
  getWorkspacesByIssueId,
  listWorkspacesSlim,
  getWorkspacesForIssues,
  getWorkspaceDetails,
  getLatestWorkspaceForIssue,
  getActiveWorkspaceCount,
  getClosedWorkspaces,
  getWorkspaceIssueContext,
  findOpenUnmergedWorkspace,
} from "./workspace-reads.repository.js";

export {
  updateWorkspaceStatus,
  deleteWorkspaceCascade,
} from "./workspace-mutations.repository.js";

export {
  getProviderMixRows,
  countMergedWorkspacesForProject,
  getCostOverTimeRows,
  getActiveWorkspacesForProject,
  getScorecardScores,
} from "./workspace-analytics.repository.js";

export {
  resolveProjectFull,
  resolveProjectRepo,
  resolveProjectId,
} from "./workspace-project-resolution.repository.js";

export {
  moveIssueToDone,
  moveIssueToInProgress,
  moveIssueToInProgressStrict,
} from "./workspace-issue-status.repository.js";

// WorkspaceDetails + its pure row->DTO projection live in
// lib/workspace-details-projection. Re-exported here so existing importers keep
// their `from "../repositories/workspace.repository"` path.
export type { WorkspaceDetails } from "../lib/workspace-details-projection.js";
