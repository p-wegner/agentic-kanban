# Agentic Kanban

A kanban board for managing AI-driven coding tasks. Cleanroom reimplementation of [vibe-kanban](https://github.com/BloopAI/vibe-kanban) — local-first, single user, Claude Code only.

## Tech Stack

TypeScript monorepo — Hono + Drizzle + React + MCP SDK

## Getting Started

```bash
pnpm install
pnpm db:setup        # migrate, seed, register this repo as a project
pnpm dev             # start server (3001) + client (5173)
```

Open http://localhost:5173

## CLI

```bash
pnpm cli -- register <path>     # register a git repo as a project
pnpm cli -- list                # list registered projects
pnpm cli -- unregister <name>   # remove a project
pnpm cli -- cleanup             # show stale worktrees
```

## Testing

```bash
pnpm test                # Vitest unit tests
pnpm test:e2e            # Playwright E2E tests
```

## Core Workflow

Register repo → Create issue → Click "New Workspace" (branch + worktree + agent launch) → View diff → Merge

## License

Private — personal use only.
