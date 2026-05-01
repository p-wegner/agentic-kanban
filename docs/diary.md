# Project Diary: Agentic Kanban Cleanroom Reimplementation

## Overview
Building a cleanroom reimplementation of [vibe-kanban](https://github.com/BloopAI/vibe-kanban), tailored to personal needs, stripping unnecessary features, with strong focus on testability and AI-driven development.

---

## 2026-05-01 — Day 1: Discovery & Analysis

### Session Goals
1. Clone the original repo
2. Perform comprehensive codebase analysis (architecture, features, agent integration, data model)
3. Create hierarchical PRD-style documentation as decision base
4. Define MVP scope and staging plan

### Actions Taken
- **Cloned repo** from `https://github.com/BloopAI/vibe-kanban` to `F:/projects/vibe-kanban`
- **Launched parallel analysis agents:**
  - Agent 1: Overall architecture & tech stack
  - Agent 2: Features & UI/UX
  - Agent 3: Agent/AI integration details
- **Created project structure** at `F:/projects/agentic_kanban/docs/`
- **Set up task tracking** with 4 tasks: analysis, PRD, MVP scoping, diary

### Key Design Decisions (to be refined)
- First iteration: **Claude Code only** (possibly via Agent SDK)
- **Testability first**: E2E tests from day one, enabling AI-driven feedback loops
- **Progressive disclosure PRD**: High-level feature overview, drill-down into technical details
- **Diary approach**: Document everything for potential talk/presentation

### Observations

**Scale of the original project is massive:**
- 34 Rust crates, 4 frontend packages, 2200+ files
- Supports 10 AI coding agents (we only need Claude Code)
- Has cloud deployment, multi-tenant, billing, OAuth, relay tunnels — all things we don't need
- Vibe Kanban is being **sunset** — makes our reimplementation more timely

**Key architectural insight:**
The core value is in the MCP server → REST API → SQLite pipeline. The kanban board is a standard CRUD app. The magic is in connecting Claude Code to the board via MCP so the agent can read/write tasks.

**Data model is surprisingly simple:**
Project → Issues (with status, priority, tags) → Workspaces (linked to issues, each with a git branch) → Sessions (agent executions). Everything else is bells and whistles.

**Testability gap in original:**
No E2E test suite found. This is a major gap we'll address from day one.

### Documents Produced
| Document | Purpose |
|----------|---------|
| `docs/prd/00-executive-summary.md` | Vision, scope, what we keep/skip |
| `docs/prd/01-features-catalog.md` | Full feature inventory with priorities |
| `docs/prd/02-architecture-analysis.md` | Original architecture deep-dive |
| `docs/prd/03-data-model.md` | Core entities and relationships |
| `docs/prd/04-agent-integration.md` | MCP/Agent integration design |
| `docs/prd/05-mvp-scope.md` | MVP definition and 6-stage plan |
| `docs/prd/06-testability-strategy.md` | E2E and testing approach |
| `docs/decisions/001-initial-scope.md` | Key decisions log |

### Analysis Agent Results Summary
- **Agent 1 (Architecture)**: Mapped all 34 crates, 4 packages, build system, config
- **Agent 2 (Features)**: Cataloged all user-facing features, UI components, data persistence
- **Agent 3 (Agent Integration)**: Detailed MCP tools, executor system, auth, communication flow
- **Agent 4 (Data Model)**: Database schema, state management, API endpoints, testing gaps

### Next Steps
- [ ] Decide on tech stack (Python vs TypeScript)
- [ ] Initialize project with test infrastructure
- [ ] Begin Stage 1: Data Layer + API

---

## Workflow Pattern
```
Clone → Analyze (parallel agents) → Document (PRD) → Decide (MVP scope) → Implement (test-first)
```

Each stage produces artifacts that feed into the next. The diary captures the meta-process.

### Methodology Notes
- Using **4 parallel subagents** for analysis was effective — each explored a different dimension
- Task tracking (TodoWrite) helped maintain focus across a multi-hour session
- The progressive disclosure PRD structure (exec summary → features → architecture → data → MVP → testing) worked well for organizing findings
- Diary is maintained as a living document, updated at session boundaries
