# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status
This project is **post-MVP core** (Stages 0-4 done). Tech stack: TypeScript monorepo — Hono + Drizzle + React + MCP SDK. Progress tracked in `docs/state.md`.

## What This Is
Cleanroom reimplementation of [vibe-kanban](https://github.com/BloopAI/vibe-kanban) — a kanban board for managing AI-driven coding tasks. Personal use only, single user, local-first. The original (being sunset) is 34 Rust crates; we're building a focused alternative.

## Key Constraints
- **Claude Code only** as the AI agent (no multi-agent support)
- **Local only** — no cloud, no multi-tenant, no OAuth
- **Testability first** — E2E tests from day one, AI-runnable feedback loops
- **Tech stack TBD** — see `docs/decisions/001-initial-scope.md` for options (Python/FastAPI or TypeScript leading)
- **PR creation is skipped** — manual merge only
- Use `uv` and `uv venv` for any Python work (never global site-packages)
- Windows environment

## Architecture Patterns
- **Avoid circular imports**: Route modules that need services (e.g., `sessionManager`) should receive them via factory functions or lazy getters, not direct imports from `index.ts`
- **MCP server DB path**: Uses `import.meta.dirname` relative path (`../../server/kanban.db`) since pnpm changes CWD per package
- **Git tests on Windows**: Use `.trim()` for file content assertions (CRLF vs LF); test git output for keywords, not exact strings
- **WS setup**: `@hono/node-ws` requires `createNodeWebSocket({ app })` then `injectWebSocket(server)` after `serve()` returns
- **Test agent substitution**: `AGENT_COMMAND` env var overrides the agent binary for E2E tests

## Visual Verification
Every feature that has a UI component must be visually verified using the `playwright-cli` skill (user-scoped). After implementing or modifying a feature:
1. Ensure dev servers are running (`pnpm dev`)
2. Use `/playwright-cli` to open the page, take a snapshot, and confirm the UI renders correctly
3. Take a screenshot only when needed for debugging — clean up `.png` files and `.playwright-cli/` after
4. Clean up any test data created during verification (reset DB with `pnpm db:migrate && pnpm db:seed`)

## Documentation Map
- `docs/prd/00-executive-summary.md` — vision, keep/skip list
- `docs/prd/05-mvp-scope.md` — MVP definition, 6-stage plan, feature matrix
- `docs/prd/03-data-model.md` — core entities (Project, Issue, Workspace, Session)
- `docs/prd/04-agent-integration.md` — MCP tools, agent lifecycle
- `docs/prd/06-testability-strategy.md` — test pyramid, per-stage test plans
- `docs/decisions/` — numbered decision records
- `docs/diary.md` — session log for talk/presentation material
- `docs/state.md` — current progress tracking (API routes, MCP tools, stage checklists)

## Monorepo Commands
- `pnpm dev` — start server + client concurrently
- `pnpm --filter @agentic-kanban/server test` — Vitest unit tests (37 tests)
- `pnpm test:e2e` — Playwright E2E tests
- `pnpm --filter @agentic-kanban/mcp-server dev` — run MCP server for testing
- `pnpm db:migrate && pnpm db:seed` — reset DB to clean state

## MVP Core Loop
Create issue → Start workspace (git branch) → Launch Claude Code → View diff → Merge

## Reference Codebase
The original vibe-kanban is at `F:/projects/vibe-kanban` for reference. Key files:
- `crates/mcp/src/task_server/` — MCP tool definitions
- `crates/db/migrations/` — database schema evolution
- `crates/api-types/src/` — shared type definitions
- `shared/types.ts` — generated TypeScript types
