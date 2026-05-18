# Competitor Analysis

Comparative analysis of kanban-style tools for managing AI-driven coding tasks.

## Tools Compared

| Tool | Origin | Tech Stack | Status |
|------|--------|------------|--------|
| [Agentic Kanban](../README.md) | Cleanroom reimplementation of vibe-kanban | TypeScript (Hono + Drizzle + React + Tauri v2) | Active, personal use |
| [Vibe Kanban](vibe-kanban.md) | Original (being sunset) | Rust (34 crates) + React + PostgreSQL/SQLite | Sunset |
| [Lanes](lanes.md) | Independent product | Tauri 2 + React 19 + SQLite | Active, proprietary, macOS-only |
| [Cline Kanban](cline-kanban.md) | By Cline (AI coding agent) | Electron + tRPC + React + JSON storage | Active, open source |

## Quick Comparison

See [feature-matrix.md](feature-matrix.md) for the full side-by-side comparison across all four tools.

## Our Positioning

See [our-positioning.md](our-positioning.md) for a synthesis of where we differentiate and gaps to consider filling.

## Methodology

- **Vibe Kanban**: Analyzed from source code at `F:/projects/vibe-kanban` (34 Rust crates)
- **Lanes**: Analyzed from public README, docs, and MCP tool surface (lanes-sh/app)
- **Cline Kanban**: Analyzed from cloned repo at `C:/andrena/cline-kanban` (commit as of 2026-05-18)
- **Agentic Kanban**: Self-documented from source code and [features catalog](../prd/01-features-catalog.md)
