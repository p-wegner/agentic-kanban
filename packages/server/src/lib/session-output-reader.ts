// Re-export of the shared single-source session-transcript file readers. The
// implementation lives in @agentic-kanban/shared/lib/session-files (a node-only
// filesystem ADAPTER, NOT barrelled into the client) so the server and mcp-server
// read per-session .out files through the same code instead of forked copies.
// Kept as a server-local module so existing importers stay unchanged, and so the
// repositories-are-infra-pure lint:arch rule keeps fs I/O out of repositories/.
export { readSessionStdoutFile, readSessionStdoutFileTail } from "@agentic-kanban/shared/lib/session-files";
