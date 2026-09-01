# Competitor Analysis

Comparative analysis of tools for managing AI-driven coding tasks — kanban-style
boards first, then adjacent tools that solve the same problem in a different shape.

## Kanban-style boards

| Tool | Origin | Tech Stack | Status |
|------|--------|------------|--------|
| [Agentic Kanban](../README.md) | Cleanroom reimplementation of vibe-kanban | TypeScript (Hono + Drizzle + React + Tauri v2) | Active, personal use |
| [Vibe Kanban](vibe-kanban.md) | Original (being sunset) | Rust (34 crates) + React + PostgreSQL/SQLite | Sunset |
| [Lanes](lanes.md) | Independent product | Tauri 2 + React 19 + SQLite | Active, proprietary, macOS-only |
| [Cline Kanban](cline-kanban.md) | By Cline (AI coding agent) | Electron + tRPC + React + JSON storage | Active, open source |
| [nodeterm](nodeterm.md) | Independent | Electron + xterm/tmux + iOS + Server Edition | Active, **BUSL-1.1** (source-available) |

## Adjacent tools — same problem, different shape

These are not boards. They solve pieces of the same problem — gates, verification,
durable state, execution records — and are the places to look for mechanisms rather
than features.

| Tool | Shape | Tech Stack | Why it is here |
|------|-------|------------|----------------|
| [LoopX](loopx.md) | Harness-neutral control plane | Python (zero deps) + a TS runtime + React dashboard | The only competitor with a **fail-closed turn-start gate**; gates where we gate at merge |
| [Apache Maka](maka.md) | Local-first agent workspace | Electron + TypeScript, one Runtime Host | The layer *below* a board: durable execution record, sandbox, compaction that keeps evidence |

## Quick Comparison

See [feature-matrix.md](feature-matrix.md) for the full side-by-side comparison across
the four original board tools. **nodeterm, LoopX and Maka are not in the matrix yet** —
LoopX and Maka do not have board features to compare, and nodeterm needs a code-level
read before its claims belong in a table that is otherwise sourced from source.

## Our Positioning

See [our-positioning.md](our-positioning.md) for a synthesis of where we differentiate
and gaps to consider filling.

## Methodology

Two different standards are in use here, and each profile says which one it used:

- **Code-level read** — claims checked against the tree, with `file:line` evidence.
  Vibe Kanban (source at `F:/projects/vibe-kanban`), Cline Kanban (clone at
  `C:/andrena/cline-kanban`, 2026-05-18), LoopX (clone at
  `C:/andrena/trending-clones/loopx`, 2026-09-01), Agentic Kanban (self-documented
  from source and the [features catalog](../prd/01-features-catalog.md)).
- **Public material only** — README, docs and product surface, not verified. Lanes
  (closed source), nodeterm (2026-09-01), Maka (2026-09-01).

## Tracking

Candidates for this list are surfaced and tracked in the `github_trending` project
(`C:/andrena/github_trending`) under the **`agent-work-orchestration`** bucket, which
exists specifically to hold this competitor set:

```bash
gt ledger --bucket agent-work-orchestration --stage triaged   # found, never analysed
gt ledger --bucket agent-work-orchestration --stale           # analysis may have expired
gt ledger --bucket agent-work-orchestration                   # the whole field
```

Every tool profiled here has a record there pointing back at its file in this
directory, so "has this one been looked at, and is the answer still current" is a
query rather than a memory.
