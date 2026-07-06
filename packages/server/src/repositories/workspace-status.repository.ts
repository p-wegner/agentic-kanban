// #967 — `setWorkspaceStatus` moved to `@agentic-kanban/shared/lib/workspace-status`
// so mcp-server can call the SAME guarded authority instead of re-implementing it
// (see that module for the full #953/#966 rationale). This file is a thin
// re-export — edit the shared module, not this one.
export {
  setWorkspaceStatus,
  type WorkspaceStatus,
  type SetWorkspaceStatusOpts,
} from "@agentic-kanban/shared/lib/workspace-status";
