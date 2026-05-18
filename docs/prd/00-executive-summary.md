# PRD-00: Executive Summary

## What is Agentic Kanban?
A personal kanban board for managing AI-driven coding tasks. Unlike generic project management tools, this is purpose-built for the workflow of:
1. **Plan** work as kanban issues
2. **Execute** work via Claude Code (AI agent)
3. **Review** diffs and provide feedback
4. **Ship** by merging

## Why a Cleanroom Reimplementation?
Vibe Kanban (the original) is being sunset and is massively over-engineered for personal use:
- 34 Rust crates, 4 frontend packages, 10+ agent executors
- Remote/cloud deployment with PostgreSQL + ElectricSQL
- Multi-tenant organizations, OAuth, billing
- Relay/WebRTC tunnel system

We need a **focused, testable** tool that does one thing well.

## Core Value Proposition
> A kanban board where each task card IS a Claude Code session, with built-in diff review and merge.

## What We Keep / Skip

See [docs/competitors/our-positioning.md](../competitors/our-positioning.md) for the full competitor analysis and positioning. Key decisions:
- **Keep**: Kanban board, workspace isolation, MCP server, real-time updates, diff review, Tauri desktop
- **Skip**: Multi-tenant, cloud deployment, multi-agent, OAuth/billing, relay tunnels

## Tech Stack
TypeScript monorepo — Hono + Drizzle + React + MCP SDK + Tauri v2. See `docs/state.md` for current status.

### Key Criterion
The stack must support **automated E2E testing** that an AI agent can run in tight feedback loops without human intervention.

## Success Metrics
1. Can create a task, launch a Claude Code session, review the diff, and merge — all from the UI
2. Full E2E test suite covering the happy path (76 unit tests + 101 E2E tests)
3. AI agent can iterate on the codebase using E2E tests as feedback
4. Single-command local setup (`pnpm db:setup && pnpm dev`)

## Current Status
All 14 stages complete (Stages 0–13 + feature extensions). The implementation exceeds the original MVP scope with features like AI code review, agent skills, live session stats, and a desktop app. See `docs/state.md` for detailed progress tracking.
