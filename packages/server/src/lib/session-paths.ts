// Re-export of the shared single-source session-file path builders. The scheme
// lives in @agentic-kanban/shared/lib/session-files so the server and mcp-server
// (and any future consumer) derive identical paths — previously this was forked
// and "kept in sync manually". Consumers continue to import from this path
// unchanged. node-only deep path (NOT barrelled into the client bundle).
export { sessionOutputPath, sessionErrorPath } from "@agentic-kanban/shared/lib/session-files";
