# Project State

## Current Stage: Stage 1 — Data Layer + API

### Stage 0 Checklist
- [x] Clone and analyze original repo (vibe-kanban)
- [x] Document features and architecture (10 docs in `docs/prd/`)
- [x] Define MVP scope (`docs/prd/05-mvp-scope.md`)
- [x] **Choose tech stack** — TypeScript: Hono + Drizzle ORM + @libsql/client (server), React + Vite + Tailwind v4 (client), pnpm workspaces
- [x] **Set up project skeleton** with test infrastructure

### Open Decisions
| ID | Question | Status | Doc |
|----|----------|--------|-----|
| D1 | Python (FastAPI) or TypeScript (Hono/Next)? | RESOLVED: TypeScript | `docs/decisions/001-initial-scope.md` |
| D2 | Claude Agent SDK directly or subprocess CLI? | OPEN | `docs/prd/04-agent-integration.md` |
| D3 | Docker isolation or bare-metal git worktrees? | OPEN | `docs/prd/04-agent-integration.md` |

### Stage Progress
| Stage | Description | Status |
|-------|-------------|--------|
| 0 | Foundation | DONE |
| 1 | Data Layer + API | READY |
| 2 | Kanban UI | NOT STARTED |
| 3 | Workspace + Agent | NOT STARTED |
| 4 | MCP Integration | NOT STARTED |
| 5 | Polish | NOT STARTED |
| 6+ | Post-MVP | NOT STARTED |

## Monorepo Structure
```
packages/
  shared/     - Drizzle schema (8 tables) + TypeScript types
  server/     - Hono API + @libsql/client + SQLite (port 3001)
  client/     - React + Vite + Tailwind v4 (port 5173)
  mcp-server/ - MCP stdio server (stub, deferred to Stage 4)
  e2e/        - Playwright tests (API + UI)
```

## Session Log
| Date | Session | Summary |
|------|---------|---------|
| 2026-05-01 | Discovery | Cloned repo, ran 4 parallel analysis agents, produced 10 PRD docs, defined MVP scope and staging plan |
| 2026-05-01 | Stage 0 | Set up TypeScript monorepo: 6 packages, Drizzle schema (8 tables), Hono API server with CRUD routes, React+Vite+Tailwind client, MCP server stub, Playwright e2e scaffold. Migrated from better-sqlite3 to @libsql/client (no VS build tools needed). Verified: /health, /api/projects, /api/issues, Vite proxy, board UI loads. |
