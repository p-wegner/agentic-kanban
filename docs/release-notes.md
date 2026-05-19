# Release Notes

## Snapshot: 94e835b — 2026-05-19

This document captures the feature set at the current snapshot. Future release notes will document the delta from this baseline.

---

### Core Features

#### Board & Issues
- Kanban board with 3 active columns (Todo, In Progress, In Review) and collapsible archive group (Done, Cancelled)
- Auto-incrementing issue numbers per project (#1, #2, #3…)
- Inline issue creation form with title, description, priority, plan mode, skip review
- Full-screen expandable create panel
- Issue detail slide-in panel: view/edit/delete, status dropdown, priority badge, tags, timestamps
- Unsaved changes guard on edit cancel/close
- Real-time search with highlighted matches; priority filter dropdown; `/` shortcut to focus, Escape to clear
- Drag-and-drop between columns (HTML5 DnD)
- Panel slide-in animations
- **Paste screenshots from clipboard** into ticket description (Ctrl+V inserts inline base64 image markdown)
- **Draggable issue detail panel** — drag by header to reposition anywhere on screen

#### Graph View
- Dependency graph showing issue relationships as nodes and edges
- Zoom in/out, pan, reset view
- **Local search input** to filter visible nodes
- **Fit-to-screen button** to auto-zoom to content bounds
- **Optimized drag/pan** using refs + requestAnimationFrame (no per-mousemove re-renders)

#### Workspaces & Agent Integration
- One-step workspace creation: git worktree + agent launch in a single POST
- Direct workspaces (work on main checkout, no worktree)
- Workspace setup scripts (blocking or parallel mode) — auto-run after worktree creation
- Session history: inline selector to browse past sessions within workspace panel
- Chat-like agent interaction: persistent input, Send/Stop toggle, Ctrl+Enter to send, multi-turn via stdin JSONL
- **Improved status badge**: shows `running` (pulsing green) and `launching…` (pulsing blue) states dynamically
- Session output/summary toggle for past sessions
- Live session stats: real-time model name and token count on issue cards via WebSocket

#### AI Code Review
- Auto-review on agent session exit (configurable)
- Manual review button
- Reviewing indicator badge
- Auto-fix setting: review agent edits and commits fixes for CRITICAL/MAJOR issues
- Auto-merge after passing review

#### Settings
- Tabbed settings modal (Agent, Workflow, Skills, MCP, UI, Project, Advanced tabs)
- Agent command/args, output parsing, mock agent toggle, claude_profile, permission_prompt_tool
- Auto-review, auto-merge, review_auto_fix toggles
- Resume with new model option
- Auto-start follow-up tasks after merge
- **Require manual approval before review** — gate review on deliberate human sign-off
- **Dynamic column scaling** — columns grow proportionally to issue count
- **Persistent agent** feature toggle (warm agent pool, experimental)

#### Command Palette & Shortcuts
- Ctrl+K searchable action list with icons, descriptions, recent actions
- `?` overlay showing all keyboard shortcuts
- `w` shortcut: New Issue + Start Workspace quick command
- `/` to focus search, Escape to clear

#### MCP Server (27 tools)
- `get_board_status` — comprehensive overview of all agents, workspaces, diff stats, session stats
- `list_issues`, `get_issue`, `create_issue`, `update_issue`, `move_issue` — issue management (supports `#N` format)
- `start_workspace`, `merge_workspace`, `get_workspace_diff` — workspace lifecycle
- `relaunch_workspace`, `review_workspace` — trigger re-launch or AI review
- `mark_ready_for_merge` — flag workspace as ready for merge
- `get_context` — project info and issue counts
- `list_tags`, `create_tag` — tag management
- `list_agent_skills`, `get_agent_skill`, `create_agent_skill`, `export_agent_skills` — skills management

#### CLI (`pnpm cli --`)
- `register`, `list`, `unregister`, `cleanup`, `status`
- `issue list/create/move`
- `workspace list/create`
- `skill list/get/create/export`
- `session-history` — debug agent session transcripts

#### Agent Skills
- 4 built-in skills: `board-navigator`, `code-review`, `dependency-analyzer`, `ticket-enhancer`
- Custom skills via DB/API/CLI — global or project-scoped
- Skill model override per skill
- `session-inspector` skill for debugging Claude sessions
- Export as Claude Code SKILL.md files

#### Multi-Provider Support
- Claude Code as primary agent
- Codex CLI provider support (launch config, session handling, skills link)
- Agent provider abstraction layer (`agent-provider.ts`)
- `claude_profile` setting flows through all session types (review, re-launch)

#### Desktop App (Tauri v2)
- System tray with Show/Quit
- Minimize-to-tray on close
- OS notifications on `session_completed` / `workspace_merged` events

#### Infrastructure
- Real-time board updates via WebSocket (`board_changed` events) + 30s polling fallback
- Session messages persisted to DB; retrieved via `GET /api/sessions/:id/output`
- Session summary endpoint: `GET /api/sessions/:id/summary` (parsed JSONL, no LLM)
- Stale session cleanup on server startup
- Board API: workspace summaries aggregated server-side
- Project setup scripts: `setup_script` + `setup_blocking` columns on projects
- `ready_for_merge` column on workspaces
- Migration journal validation (monotonic timestamps, statement-breakpoint markers)

---

### Release Note Generation Workflow

To generate release notes for a new snapshot:

1. Note the current HEAD SHA: `git rev-parse --short HEAD`
2. Compare to the previous snapshot SHA recorded in the last release notes entry
3. Run: `git log --oneline <prev-sha>..HEAD` to list commits since the last snapshot
4. Group commits by feature area (Board, Workspaces, Settings, MCP, CLI, Infrastructure)
5. Add a new `## Snapshot: <sha> — <date>` section at the top of this file documenting the delta
6. Commit: `git commit -m "docs: release notes snapshot <sha>"`

The snapshot version format is `<short-sha> — <YYYY-MM-DD>` (no semver, no tags required).
