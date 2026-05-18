# Lanes — Competitor Profile

**Repository**: [github.com/lanes-sh/app](https://github.com/lanes-sh/app) (private/proprietary)
**License**: Proprietary
**Last analyzed**: 2026-05-15 (commit `b256513`)

## What It Is

"Mission control for AI coding agents." A native macOS desktop app for managing AI-driven coding tasks with deep integration with Linear, GitHub, and Claude Code.

## Architecture

| Aspect | Detail |
|--------|--------|
| Platform | Native macOS desktop (Tauri 2) |
| Frontend | React 19 + Radix UI + Tailwind CSS |
| Storage | SQLite, local-first |
| Agent support | Claude Code now; Codex/Gemini CLI on roadmap |
| Install | `brew install --cask lanes-sh/lanes/lanes` |

## Core Features

### Board & Task Management
- **Columns**: Planning, Implementation, Review, Done + Backlog, Misc (6 columns)
- Collapsible column groups
- **Multi-select**: Shift+Click, Cmd+Click with bulk operations
- **Right-click context menus**
- Board tabs per project/worktree
- Drag-and-drop between columns
- Labels with 13 color options, filter by label

### Agent Execution
- Plan mode vs implement mode (two session types)
- Resume sessions across restarts
- Real-time status detection: busy / awaiting input / stopped / exited / error
- Chat-like interaction via terminal input

### Worktree Management
- Auto-create per issue with generated branch names
- Select existing worktrees
- Auto-cleanup on done
- Base branch detection with manual override

### Code Review
- Two diff modes: Changes (uncommitted) + History (committed)
- Monaco-powered diff viewer
- No inline diff comments

### Integrations
- **Linear**: Full OAuth bridge (import/export, round-trip sync)
- **GitHub**: Full OAuth bridge (import/export, round-trip sync)
- **Claude Code plugin marketplace**: Skills + setup command

### MCP Server
- 15 tools, SSE transport (localhost:5353)

### Desktop App
- Native macOS via Tauri 2
- Auto-updates
- Process manager: discover running CLIs (Tracked/Orphan/External), kill processes

### Other Features
- Quick commands: Cmd+Alt+1-9, claude/terminal types, customizable
- File browser + Monaco editor (sidebar file tree, tabbed editing, dirty tracking, Cmd+S)
- Dependencies between issues (cycle detection, blocking)
- Session history via Claude session resume
- Filtering by label, working directory, workflow step

## MCP Tool Comparison

| Lanes Tool | Purpose |
|------------|---------|
| `lanes_list_issues` | List with step, tags, componentId, search filters |
| `lanes_get_issue` | Get issue details |
| `lanes_create_issue` | Create issue |
| `lanes_update_issue` | Update fields |
| `lanes_delete_issue` | Delete issue |
| `lanes_move_issue` | Move to different column |
| `lanes_start_session` | Start agent session (plan mode, prompts, flags/env vars) |
| `lanes_stop_session` | Stop running session |
| `lanes_get_session_status` | Get current session state |
| `lanes_get_issue_changes` | Get diff/changes |
| `lanes_get_issue_history` | Paginated Claude transcript |
| `lanes_read_terminal` | Last N lines, ANSI stripped |
| `lanes_get_session_stats` | Tokens, model, tool calls, duration |
| `lanes_list_labels` | List project labels |
| `lanes_list_components` | List components |
| **+ 6 Linear bridge tools** | list teams/issues, search, get, create, comment |
| **+ 6 GitHub bridge tools** | list repos/issues, search, get, create, comment |

**Total**: 27 tools (15 core + 12 integration bridges)

## Strengths

1. **Polished macOS UX** — native feel with Tauri 2
2. **Deep integrations** — Linear and GitHub OAuth bridges
3. **Rich MCP surface** — 27 tools including session stats, terminal reading
4. **Process manager** — system-wide CLI discovery and management
5. **File browser + editor** — Monaco-powered in-app code editing
6. **Issue dependencies** — cycle detection, blocking
7. **Multi-select + context menus** — bulk operations
8. **Plugin marketplace** — Claude Code skills ecosystem
9. **Auto-updates** — seamless version management

## Weaknesses

1. **macOS only** — no Windows or Linux support
2. **Proprietary** — closed source
3. **No E2E test suite** — no visible automated testing
4. **No mock agent** — no testing harness
5. **No inline diff comments** — can't comment on specific lines
6. **No direct workspaces** — always creates worktree
7. **No command palette** — no quick-action search
8. **No search highlighting** — no visual match feedback on cards
