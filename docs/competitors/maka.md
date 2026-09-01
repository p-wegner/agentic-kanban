# Apache Maka (Incubating) — Competitor Profile

**Repository**: [github.com/apache/maka](https://github.com/apache/maka)
**License**: Apache-2.0 (ASF incubating; ICLA/CCLA via the ASF, not a company CLA)
**Last analyzed**: 2026-09-01
**Evidence level**: public README, `ARCHITECTURE.md` and release metadata only —
**not read at code level**. Feature claims below are the project's own.

## What It Is

A local-first **agent workspace**, not a board: an Electron desktop app (plus TUI/CLI
and an eval runner) where every surface executes agents through one **Runtime Host**,
and every model message, tool call, tool result and turn outcome is written down as a
durable, replayable execution record.

The overlap with Agentic Kanban is the **record and the sandbox**, not the workflow.
Maka has no cards, no columns, no worktree-per-task and no merge gate; what it has is
the audit and recovery layer underneath a session, done more rigorously than anyone
else in this space.

## Architecture

| Aspect | Detail |
|--------|--------|
| Runtime | Node.js 22.19+ (CI on 24), TypeScript, npm workspaces |
| Desktop | Electron + React — streaming sessions, tool timelines, branching, search, recovery |
| Other surfaces | `maka` TUI/CLI (`maka run` for one non-interactive turn); `maka eval run` |
| Central seam | **Runtime Host** — desktop, terminal and eval all go through it |
| Storage | Local execution record: model messages, tool calls, results, termination reason |
| Sandbox | Built-in tools (`Read`/`Write`/`Edit`/`Bash`/`Glob`/`Grep`); anything leaving the sandbox needs approval |
| Native | Direct Peer / Peer Mesh need Rust ≥1.98 |
| Platforms | macOS arm64 nightly; **Windows unsigned preview**; Linux not yet |
| Status | Incubating — **no ASF release yet**; nightlies are not releases |

## Core Features

### The record
- Model messages, tool calls, tool results and how a turn ended are persisted
- **The UI and the next model call are views of that record, not the only copy**
- Context compaction omits old tool output from the next prompt **without deleting the
  saved evidence** — shortening context is not losing history
- Crash recovery and optional resume of an interrupted turn; failures are classified

### Session workspace
- Create, archive, search, rename, retry, regenerate and **branch a session from a turn**
- Artifact lists and previews, workspace instructions, model and sandbox settings
- Multiple model connections (cloud API, local model, or gateway — bring your own)
- Local memory and web search when configured; IM/chat-app bots experimental

### Evaluation
- Declarative multi-arm experiments expanded into task × repetition × subject cells
- Immutable per-cell attempts, targeted infrastructure replacement, earliest-valid
  selection
- A result kernel: score, normalized usage, attributable cost, duration, status,
  failure reason, artifacts
- Maka subjects run only through Runtime Host; external subjects use adapters

## Strengths

1. **One Runtime Host for every surface** — desktop, CLI and eval cannot drift, because
   there is one execution path
2. **Execution record as the source of truth**, with the UI demoted to a view of it
3. **Compaction that preserves evidence** — the cleanest answer anyone in this space has
   to "the context got long"
4. **Permission decisions are part of the record**, not just a modal that happened once
5. **A real evaluation harness** with cost/usage attribution — nobody else here has one
6. **ASF governance**, Apache-2.0, no vendor CLA

## Weaknesses

1. **Not a board** — no cards, columns, dependencies, worktrees or merge gate; it is
   one session at a time, not a queue of work
2. **No Windows support tier** (unsigned preview), no Linux; we run on Windows
3. **No ASF release exists yet**; data formats and CLI "may still change"
4. Heavier stack — Electron plus a Rust native addon for peer features
5. Not read at code level

## What To Steal

| Idea | Why | Effort |
|---|---|---|
| **Compaction that keeps the evidence** — omit old tool output from the next prompt while retaining it in the session record | Directly serves our "observability and control" positioning: a long-running card should shrink its context without losing what a reviewer needs | Medium |
| **One execution seam for every surface** (server, CLI, MCP) | We already have a CLI and MCP; a single Runtime-Host-equivalent is what stops them drifting from the server path | Medium (architectural) |
| **Permission decisions written into the session record** | Makes "why did the agent do that" answerable after the fact, and pairs with a turn-start gate (see loopx) | Low |
| **A declarative eval spec with cost/usage attribution** | We have a mock Claude profile and 101+ E2E tests; a scored eval over real cards is the missing half | High |

## Verdict

**Study.** Different shape, adjacent problem: Maka is the layer *below* a board. The
compaction-preserves-evidence design and the single Runtime Host seam are the two
things worth reading properly if we ever rework session storage.
