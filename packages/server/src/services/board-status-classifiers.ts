// Server-facing shim. The pure board-status classifiers now live in the shared leaf
// (single source of truth across server + MCP — see the module's header). Re-exported
// here so existing server callers (board-status.ts) and tests keep their import path.
export {
  classifyBoardStatusIssueAttention,
  classifyBoardStatusIssueMergeState,
  type BoardStatusClassificationOptions,
} from "@agentic-kanban/shared/lib/board-status-classifiers";
