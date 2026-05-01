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
- Tauri desktop app wrapper
- Multi-tenant organizations, OAuth, billing
- Relay/WebRTC tunnel system

We need a **focused, testable** tool that does one thing well.

## Core Value Proposition
> A kanban board where each task card IS a Claude Code session, with built-in diff review and merge.

## What We Keep (from original)
- Kanban board with issues, statuses, priorities, tags
- Workspace = isolated git branch + agent execution
- MCP server for agent integration
- Real-time updates (simplified)
- Diff viewer with inline comments

## What We Skip (from original)
- Multi-tenant / organizations / team collaboration
- Cloud deployment / ElectricSQL / PostgreSQL
- Tauri desktop wrapper
- 9 additional agent executors (keep only Claude Code)
- Relay / WebRTC / tunnel system
- OAuth / billing / Sentry / PostHog
- Mobile-specific support
- Internationalization (i18next)
- Preview browser / dev server proxy
- Embedded SSH
- Multiple host support
- PR creation with AI descriptions

## Tech Stack Decision (for reimplementation)
> TBD - to be decided after MVP scoping. Options:
> - **Option A**: Python (FastAPI + React/Vue) - most testable, fastest to develop
> - **Option B**: TypeScript full-stack (Next.js or Hono + React) - unified language
> - **Option C**: Rust + React (like original) - proven but heavy

### Key Criterion
The stack must support **automated E2E testing** that an AI agent can run in tight feedback loops without human intervention.

## Success Metrics
1. Can create a task, launch a Claude Code session, review the diff, and merge - all from the UI
2. Full E2E test suite covering the happy path
3. AI agent can iterate on the codebase using E2E tests as feedback
4. Single-command local setup
