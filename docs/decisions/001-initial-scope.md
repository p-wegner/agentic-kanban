# Decision 001: Initial Scope and Tech Stack

## Date: 2026-05-01

## Decision

### Scope
- MVP = Kanban board + Claude Code workspace + Diff viewer
- Single user, single project, local only
- SQLite for persistence
- MCP server for agent integration

### Tech Stack: TypeScript Full-Stack

**Server**: Hono + Drizzle ORM + @libsql/client (SQLite)
**Client**: React 19 + Vite 7 + Tailwind v4
**Monorepo**: pnpm workspaces (6 packages)
**Tests**: Vitest (unit) + Playwright (e2e)
**MCP**: TypeScript MCP SDK

**Why TypeScript over Python (FastAPI)**:
- Shared types between server, client, and MCP server (one type system)
- Drizzle ORM provides end-to-end type safety from schema to queries
- Hono is lighter than FastAPI for a single-user local tool
- React + Vite + Tailwind v4 is the current best-in-class SPA stack
- Official MCP SDK for TypeScript is well-maintained

**Why NOT Rust (like original)**:
- 34 crates is massive overkill for a personal tool
- Rust's compile times slow the AI-driven feedback loop
- Python/TS have better MCP SDK support
- Test infrastructure is more mature in Python/TS

**Why @libsql/client instead of better-sqlite3**:
- better-sqlite3 requires Visual Studio C++ build tools (node-gyp)
- @libsql/client ships prebuilt native binaries — no compilation needed
- Compatible with Drizzle ORM's migration tooling (drizzle-kit)
- Local file access with `file:` prefix, same as SQLite

## Rationale
1. **Testability > Performance**: A personal kanban board has zero performance concerns
2. **AI feedback loops**: Faster iteration cycles = better AI-assisted development
3. **Simplicity**: Every line of code is a maintenance burden; TS = fewer lines than Rust
4. **Type safety**: Shared types across the entire stack reduce bugs

## Resolved
- [x] ~~Python or TypeScript?~~ -> TypeScript
- [x] ~~Use Claude Agent SDK directly, or subprocess Claude Code CLI?~~ -> both: CLI subprocess for task agents, Agent SDK for the Butler (see [003-butler-architecture-agent-sdk-vs-cli.md](003-butler-architecture-agent-sdk-vs-cli.md))
- [ ] Use Docker for workspace isolation, or bare metal?
