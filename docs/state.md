# Project State

## Current Stage: Stage 2 — Kanban UI

### Stage 0 Checklist
- [x] Clone and analyze original repo (vibe-kanban)
- [x] Document features and architecture (10 docs in `docs/prd/`)
- [x] Define MVP scope (`docs/prd/05-mvp-scope.md`)
- [x] **Choose tech stack** — TypeScript: Hono + Drizzle ORM + @libsql/client (server), React + Vite + Tailwind v4 (client), pnpm workspaces
- [x] **Set up project skeleton** with test infrastructure

### Stage 1 Checklist
- [x] Board aggregation endpoint (`GET /api/projects/:id/board`)
- [x] Workspace CRUD routes (POST, GET, PATCH, DELETE + issue workspaces list)
- [x] Vitest unit test setup with in-memory DB (17 tests passing)
- [x] Client updated to use board endpoint (single API call)
- [x] Playwright e2e tests for workspaces and board endpoints
- [x] Shared types for workspace request/response

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
| 1 | Data Layer + API | DONE |
| 2 | Kanban UI | READY |
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

## API Routes
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/projects | List all projects |
| POST | /api/projects | Create a project |
| GET | /api/projects/:id/statuses | List statuses for a project |
| POST | /api/projects/:id/statuses | Create a status |
| GET | /api/projects/:id/board | Get board (statuses + nested issues) |
| GET | /api/issues?projectId= | List issues for a project |
| POST | /api/issues | Create an issue |
| PATCH | /api/issues/:id | Update an issue |
| DELETE | /api/issues/:id | Delete an issue |
| GET | /api/issues/:id/workspaces | List workspaces for an issue |
| POST | /api/workspaces | Create a workspace |
| GET | /api/workspaces/:id | Get workspace with issue info |
| PATCH | /api/workspaces/:id | Update workspace status |
| DELETE | /api/workspaces/:id | Delete a workspace |

## Session Log
| Date | Session | Summary |
|------|---------|---------|
| 2026-05-01 | Discovery | Cloned repo, ran 4 parallel analysis agents, produced 10 PRD docs, defined MVP scope and staging plan |
| 2026-05-01 | Stage 0 | Set up TypeScript monorepo: 6 packages, Drizzle schema (8 tables), Hono API server with CRUD routes, React+Vite+Tailwind client, MCP server stub, Playwright e2e scaffold. Migrated from better-sqlite3 to @libsql/client (no VS build tools needed). Verified: /health, /api/projects, /api/issues, Vite proxy, board UI loads. |
| 2026-05-01 | Stage 1 | Added board aggregation endpoint, workspace CRUD routes, Vitest unit test setup (17 tests, in-memory DB), updated client to use single board API call, added Playwright e2e tests for workspaces and board. Refactored routes to use factory functions for testability. |
