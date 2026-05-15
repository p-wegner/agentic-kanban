# Lanes vs Agentic Kanban — Feature Comparison

**Date**: 2026-05-15

**Commits compared**:
- Agentic Kanban: `1e168d5` — Merge branch 'feature/merge-test-mp6yamd9'
- Lanes (lanes-sh/app): `b256513` — chore: update mcp with integrations

---

## What they are

| | **Lanes** (lanes-sh/app) | **Agentic Kanban** |
|---|---|---|
| **Tagline** | "Mission control for AI coding agents" | "Kanban board for AI-driven coding tasks" |
| **Origin** | Independent product, proprietary | Cleanroom reimplementation of vibe-kanban |
| **Platform** | Native macOS desktop (Tauri 2) | Web app (Hono+React) + Tauri desktop |
| **Tech stack** | Tauri 2, React 19, SQLite, local-first | Hono, Drizzle, React, MCP SDK, Tauri v2 |
| **Agent support** | Claude Code now; Codex/Gemini CLI on roadmap | Claude Code only |
| **License** | Proprietary | Personal use |
| **Install** | `brew install --cask lanes-sh/lanes/lanes` | `pnpm install && pnpm db:setup && pnpm dev` |

## Feature Matrix

| Feature | Lanes | Agentic Kanban | Notes |
|---|---|---|---|
| **Board columns** | Planning, Implementation, Review, Done + Backlog, Misc | Todo, In Progress, In Review, Done, Cancelled | Lanes has 6 columns with Backlog; ours has 5 with Cancelled |
| **Collapsible columns** | Yes | Yes (archive group for Done/Cancelled) | |
| **Multi-select** | Shift+Click, Cmd+Click, bulk ops | No | Lanes advantage |
| **Right-click context menus** | Yes | No | Lanes advantage |
| **Board tabs per project/worktree** | Yes | No (project switcher dropdown instead) | Different UX approach |
| **Drag-and-drop** | Implied (drag through columns) | Yes (HTML5 DnD) | |
| **Live embedded terminal** | PTY-backed, real terminal | WebSocket streaming of agent stdout | Lanes has true PTY; we stream parsed output |
| **Plan mode vs implement mode** | Yes (two session types) | No (single mode, but --resume for follow-up) | |
| **Resume sessions** | Yes (across restarts) | Yes (--resume with claudeSessionId) | |
| **Real-time status detection** | busy/awaiting input/stopped/exited/error | Running/stopped (derived from session state) | Lanes has more granular states |
| **Chat-like interaction** | Implied (terminal input) | Yes (persistent chat input, Send/Stop, multi-turn via --resume) | We have explicit chat UX |
| **Worktree management** | Auto-create per issue, generated branch names, select existing, auto-cleanup on done | One-step create (DB + worktree + launch), branch suggestion, base branch selection, direct workspaces | We auto-launch agent; Lanes separates creation from session start |
| **Direct workspace (no worktree)** | Not mentioned | Yes (work on main checkout, purple badge) | Our advantage |
| **Base branch detection** | Yes, with manual override | Yes (from project defaultBranch, optional override) | |
| **Diff viewer** | Two modes: Changes (uncommitted) + History (committed), Monaco-powered | Unified + split view, inline comments | We have comments; Lanes has history mode |
| **Inline diff comments** | Not mentioned | Yes (CRUD, create/edit/delete per file+line) | Our advantage |
| **Merge workflow** | Not explicitly described | Yes (merge into defaultBranch, close workspace) | |
| **Labels/Tags** | Labels with 13 color options, filter by label | Tags with 4 seed tags + CRUD, assign to issues | Similar capability, Lanes has more colors |
| **Filtering** | By label, working directory, workflow step | By text search (with highlighting), priority dropdown | Different filtering axes |
| **Dependencies** | Yes (link issues, cycle detection, blocked until prereqs done) | No | Lanes advantage |
| **Quick commands** | Yes (Cmd+Alt+1-9, claude/terminal types, customizable) | No | Lanes advantage |
| **File browser & editor** | Yes (sidebar file tree, Monaco, tabbed editing, dirty tracking, Cmd+S) | No | Lanes advantage |
| **Process manager** | Yes (discover running CLIs, Tracked/Orphan/External, kill) | No | Lanes advantage |
| **Session history** | Via Claude session resume | Yes (inline session selector, past output replay, DB-persisted messages) | |
| **MCP server** | 15 tools, SSE transport (localhost:5353) | 8 tools, stdio transport | Lanes has nearly 2x the tools |
| **Linear integration** | Yes (OAuth, import/export, round-trip) | No | Lanes advantage |
| **GitHub integration** | Yes (OAuth, import/export, round-trip) | No | Lanes advantage |
| **Claude Code plugin marketplace** | Yes (skills + setup command) | No | Lanes advantage |
| **Command palette** | Not mentioned | Yes (Ctrl+K, searchable, keyboard nav) | Our advantage |
| **Keyboard shortcut help** | Table in README | Yes (? overlay) | |
| **Multi-project** | Yes (board tabs per project dir) | Yes (project switcher dropdown) | Different UX |
| **Settings panel** | Yes | Yes (agent command/args, output parser, mock agent) | |
| **Mock agent for testing** | Not mentioned | Yes (toggle in settings, standalone script) | Our advantage |
| **Worktree overview** | Status bar with uncommitted/unmerged | Yes (slide-in panel, all worktrees, diff stats, issue links) | |
| **Workspace deletion** | Implied (auto-cleanup on done) | Yes (explicit delete with confirmation, cascade) | |
| **OS notifications** | Not mentioned | Yes (Tauri tray, session_completed/workspace_merged) | |
| **Auto-updates** | Yes | No | Lanes advantage |
| **E2E test suite** | Not visible (proprietary) | 100 Playwright E2E tests + 76 unit tests | Our advantage |
| **Issue numbers** | Numeric IDs | Yes (auto-incrementing per project, #1, #2...) | |
| **Search highlighting** | Not mentioned | Yes (yellow mark on matching text) | |

## MCP Tool Comparison

| Tool | Lanes | Agentic Kanban |
|---|---|---|
| List issues (with filters) | `lanes_list_issues` (step, tags, componentId, search) | `list_issues` (status, priority, tag) |
| Get issue | `lanes_get_issue` | `get_issue` |
| Create issue | `lanes_create_issue` | `create_issue` |
| Update issue | `lanes_update_issue` | `update_issue` |
| Delete issue | `lanes_delete_issue` | — (not in MCP, only REST API) |
| Move issue | `lanes_move_issue` | — (use update_issue) |
| Start session | `lanes_start_session` (plan mode, custom prompts, flags/env vars) | `start_workspace` (auto-launch) |
| Stop session | `lanes_stop_session` | — (only REST API) |
| Session status | `lanes_get_session_status` | — |
| Get changes/diff | `lanes_get_issue_changes` | `get_workspace_diff` |
| Session history | `lanes_get_issue_history` (paginated Claude transcript) | — |
| Read terminal | `lanes_read_terminal` (last N lines, ANSI stripped) | — |
| Session stats | `lanes_get_session_stats` (tokens, model, tool calls, duration) | — |
| List labels | `lanes_list_labels` | — (only REST API) |
| List components | `lanes_list_components` | — |
| Get context | — | `get_context` |
| List workspaces | — | `list_workspaces` |
| Linear bridge tools | 6 tools (list teams/issues, search, get, create, comment) | — |
| GitHub bridge tools | 6 tools (list repos/issues, search, get, create, comment) | — |
| **Total** | **15 tools** | **8 tools** |

## Key Differences Summary

### Lanes has that we don't

1. Dependencies between issues (cycle detection, blocking)
2. File browser + Monaco editor
3. Process manager (system-wide CLI discovery)
4. Quick commands (preset shortcuts)
5. Multi-select + bulk operations
6. Right-click context menus
7. Linear integration (full OAuth bridge)
8. GitHub integration (full OAuth bridge)
9. Plan mode sessions
10. Session stats (tokens, cost, tool calls)
11. Read terminal via MCP
12. Claude Code plugin marketplace
13. Auto-updates
14. Richer MCP surface (15 vs 8 tools)
15. True PTY-backed terminals

### We have that Lanes doesn't

1. Inline diff comments (CRUD per file+line)
2. Chat-like agent interaction (persistent input, multi-turn)
3. Direct workspaces (no worktree needed)
4. Mock agent for testing
5. Command palette (Ctrl+K)
6. Search result highlighting
7. Comprehensive E2E test suite (100 tests)
8. Output parsing of Claude stream-json format
9. Session messages persisted to DB
10. Real-time board refresh (WebSocket + polling)
11. Inline session history switching
12. OS notifications via Tauri tray

## Architecture Differences

| Aspect | Lanes | Agentic Kanban |
|---|---|---|
| Transport | SSE (localhost:5353) | stdio (MCP), WebSocket (agent output) |
| Terminal | PTY-backed real terminal | Parsed stdout stream |
| DB | SQLite | SQLite (Drizzle ORM) |
| Multi-agent | Claude Code + Codex/Gemini roadmap | Claude Code only |
| Monorepo | Yes (Tauri app) | Yes (pnpm workspaces, 5 packages) |

## Bottom Line

Lanes is a **more mature, polished product** with broader integration surface (Linear, GitHub, multi-agent support planned) and richer UI features (file editor, process manager, dependencies, multi-select). It's macOS-only and proprietary.

Agentic Kanban is **more developer/test-friendly** — 176 automated tests, mock agent, parsed output view, diff comments, and runs on Windows. The chat-like interaction model and one-step workspace creation are unique UX approaches. It's open for personal use and built on a clean TypeScript stack.
