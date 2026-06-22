// Re-export of the shared single-source board-status projection. The pure assembly
// helpers (parseSessionStats / buildBoardStatusEntry / selectLatestRelevantSession)
// live in @agentic-kanban/shared/lib/board-status-entry so the server service and
// the mcp-server get_board_status tool build the IDENTICAL wire entry instead of
// forked copies. Importers (board-status.ts + its test) are unchanged.
export {
  parseSessionStats,
  selectLatestRelevantSession,
  buildBoardStatusEntry,
  type BoardStatusEntryIssue,
  type BoardStatusEntryWorkspace,
  type BoardStatusEntrySession,
} from "@agentic-kanban/shared/lib/board-status-entry";
