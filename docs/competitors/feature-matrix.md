# Feature Matrix — All Tools Compared

Side-by-side comparison of all four AI-driven kanban tools. See individual profiles for details:
[vibe-kanban](vibe-kanban.md) | [Lanes](lanes.md) | [Cline Kanban](cline-kanban.md) | [Agentic Kanban](../../README.md)

---

## Overview

| | **Vibe Kanban** | **Lanes** | **Cline Kanban** | **Agentic Kanban** |
|---|---|---|---|---|
| **Tagline** | AI kanban (sunset) | "Mission control for AI agents" | AI agent task manager | Kanban for AI-driven coding tasks |
| **Status** | Sunset | Active, proprietary | Active, open source | Active, personal use |
| **Platform** | macOS/Linux | macOS only | Cross-platform (Electron) | Cross-platform (Web + Tauri) |
| **Backend** | Rust (Axum) | Tauri 2 native | Node.js (Express + tRPC) | Node.js (Hono) |
| **Frontend** | React 18 | React 19 | React + Tailwind v4 + Radix | React + Tailwind |
| **Database** | SQLite / PostgreSQL | SQLite | JSON files | SQLite (Drizzle ORM) |
| **Desktop** | Tauri | Tauri 2 | Electron | Tauri v2 |
| **Agent count** | 10+ | 1 (Claude Code, more planned) | 7+ | 1 (Claude Code only) |

---

## Board & Task Management

| Feature | Vibe Kanban | Lanes | Cline Kanban | Agentic Kanban |
|---------|-------------|-------|--------------|----------------|
| Default columns | 5 (configurable) | 6 (Planning, Implementation, Review, Done, Backlog, Misc) | 4 (Backlog, In Progress, Review, Done) | 5 (Todo, In Progress, In Review, Done, Cancelled) |
| Collapsible groups | Yes | Yes | No | Yes (archive group for Done/Cancelled) |
| Drag-and-drop | Yes | Yes | Yes | Yes (HTML5 DnD) |
| Multi-select | No | Yes (Shift/Cmd+Click, bulk ops) | No | No |
| Right-click menus | No | Yes | No | No |
| Issue numbers | Yes | Numeric IDs | Yes | Yes (auto-increment per project) |
| Tags/Labels | Yes | Yes (13 colors) | Yes | Yes (4 seed tags + CRUD) |
| Priority levels | Yes | Yes | Yes | Yes (Urgent/High/Medium/Low) |
| Search | Basic | By label, directory, step | Basic | Full-text with highlighting |
| Filter | By status | By label, dir, step | Basic | By text, priority, status |
| Task dependencies | No | Yes (cycle detection) | Yes (auto-chain) | No |
| AI enhancement | No | No | No | Yes (Enhance with AI button) |
| Board tabs | No | Yes (per project/worktree) | No | No (dropdown switcher) |
| Project switcher | Yes | Yes | Yes | Yes (dropdown) |

---

## Agent Execution & Sessions

| Feature | Vibe Kanban | Lanes | Cline Kanban | Agentic Kanban |
|---------|-------------|-------|--------------|----------------|
| **Agents supported** | 10+ (plugin executors) | Claude Code (+ Codex/Gemini planned) | Cline, Claude Code, Codex, Gemini CLI, Kiro, Factory Droid, OpenCode | Claude Code only |
| Session types | Single | Plan mode vs implement mode | Single | Single |
| Terminal | xterm.js | PTY-backed real terminal | node-pty (real PTY) | WebSocket stream (parsed stdout) |
| Chat-like interaction | No | Implied (terminal input) | No | Yes (persistent chat input, Send/Stop) |
| Multi-turn / resume | Yes | Yes (across restarts) | Yes | Yes (--resume with claudeSessionId) |
| Session status | Basic | busy/awaiting/stopped/exited/error | Basic | Running/stopped (derived) |
| Session stats | No | Yes (tokens, model, tool calls, duration) | No | Yes (model + context tokens, live) |
| Agent task progress | No | No | No | Yes (TodoWrite/TaskCreate via WS) |
| Subagent visibility | No | No | No | Yes (ID tracking, visual indentation) |
| Plan mode | No | Yes (separate session type) | No | Yes (--permission-mode plan flag) |
| Auto-commit/PR | No | No | Yes (commit or PR on completion) | No |
| Auto-review | No | No | Yes | Yes (on agent exit, configurable) |
| Agent skills | No | Plugin marketplace | No | Yes (4 built-in + custom SKILL.md) |
| Mock agent (testing) | No | No | No | Yes (toggle in settings) |

---

## Git Integration & Worktrees

| Feature | Vibe Kanban | Lanes | Cline Kanban | Agentic Kanban |
|---------|-------------|-------|--------------|----------------|
| Worktree per task | Yes (Docker container) | Yes (auto-create) | Yes (ephemeral) | Yes (one-step create + launch) |
| Direct workspace (no worktree) | No | No | No | Yes (work on main checkout) |
| Symlinked node_modules | No | No | Yes | No |
| Base branch selection | Yes | Yes (auto-detect + manual) | Yes | Yes (dropdown from API) |
| Branch naming | Auto-generated | Auto-generated | Auto-generated | Auto-suggested (`feature/ak-<N>-<title>`) |
| Worktree overview | No | Status bar | No | Yes (slide-in panel, diff stats, issue links) |
| Worktree cleanup | Manual | Auto on done | Auto on completion | Manual (delete workspace) |
| Setup scripts | No | No | No | Yes (blocking or parallel, AI-generate) |
| Merge workflow | Yes | Not described | Yes | Yes (merge into defaultBranch) |
| Conflict detection | No | No | Yes | Yes (git merge-tree, read-only) |
| Detached HEAD guard | No | No | No | Yes (syncBranchToHead + ensureOnBranch) |

---

## Code Review & Diff

| Feature | Vibe Kanban | Lanes | Cline Kanban | Agentic Kanban |
|---------|-------------|-------|--------------|----------------|
| Diff viewer | Yes | Yes (Monaco, Changes + History modes) | Yes (file tree + multi-line) | Yes (unified + split view) |
| Inline diff comments | No | No | Yes (multi-line, line selection) | Yes (CRUD per file+line) |
| File tree navigation | Yes | Yes | Yes | Yes |
| Diff stats | Yes | Yes | Yes | Yes (+N/-N lines, files changed) |
| Untracked files in diff | Unknown | Unknown | Unknown | Yes (git ls-files --others) |
| Session summary | No | Paginated transcript | No | Yes (parsed from JSONL, no LLM) |
| Output/Summary toggle | No | No | No | Yes |

---

## MCP Tools

| Feature | Vibe Kanban | Lanes | Cline Kanban | Agentic Kanban |
|---------|-------------|-------|--------------|----------------|
| Transport | stdio | SSE (localhost:5353) | stdio / SSE / HTTP | stdio |
| Tool count | 18 | 27 (15 core + 12 bridges) | Dynamic (loaded from servers) | 27 |
| Session management | Yes (create/stop/delete) | Yes (start/stop/status) | Via runtime hooks | Yes (start/stop/resume) |
| Board interaction | Yes (CRUD issues) | Yes (CRUD + move) | Via tasks | Yes (CRUD + move) |
| Diff access | No | Yes (get_issue_changes) | No | Yes (get_workspace_diff) |
| Terminal output | No | Yes (read_terminal, ANSI stripped) | No | Yes (session output from DB) |
| Session stats | No | Yes (tokens, cost, tools, duration) | No | Yes (model, context tokens) |
| Agent skills | No | No | No | Yes (list/get/create/export) |
| Board status overview | No | No | No | Yes (get_board_status) |
| OAuth for MCP | No | No | Yes (browser flow) | No |
| Dynamic tool discovery | No | No | Yes | No |

---

## Integrations & Desktop

| Feature | Vibe Kanban | Lanes | Cline Kanban | Agentic Kanban |
|---------|-------------|-------|--------------|----------------|
| Linear integration | No | Yes (full OAuth bridge) | No | No |
| GitHub integration | No | Yes (full OAuth bridge) | No | No |
| Desktop app | Tauri | Tauri 2 | Electron | Tauri v2 |
| System tray | Yes | No | No | Yes |
| OS notifications | No | No | No | Yes (session_completed, workspace_merged) |
| Auto-updates | No | Yes | No | No |
| Protocol handlers | No | No | Yes (deep linking) | No |
| File browser/editor | No | Yes (Monaco) | No | No |
| Process manager | No | Yes (CLI discovery, kill) | No | No |
| Script shortcuts | No | No | Yes (per-project commands) | No |
| CLI | No | No | No | Yes (register, issue, workspace, skill, status) |
| NPX install | Yes | No (brew) | No | No |
| Docker deploy | Yes | No | No | No |

---

## Testing & Developer Experience

| Feature | Vibe Kanban | Lanes | Cline Kanban | Agentic Kanban |
|---------|-------------|-------|--------------|----------------|
| E2E test suite | Unknown | Not visible (proprietary) | Not visible | Yes (100+ Playwright tests) |
| Unit tests | Unknown | Unknown | Unknown | Yes (76 Vitest tests) |
| Mock agent | No | No | No | Yes (standalone script, toggle) |
| DB migrations | Yes (SQLx) | Unknown | No (JSON storage) | Yes (Drizzle + journal, 20 migrations) |
| Worktree port strategy | No | No | No | Yes (deterministic per branch) |

---

## UI/UX

| Feature | Vibe Kanban | Lanes | Cline Kanban | Agentic Kanban |
|---------|-------------|-------|--------------|----------------|
| Command palette | No | No | No | Yes (Ctrl+K, searchable) |
| Keyboard shortcut help | No | Table in README | No | Yes (? overlay) |
| Search highlighting | No | No | No | Yes (yellow mark) |
| Slide-in panels | Yes | Yes | Yes | Yes (animated) |
| Dark/light theme | Yes | Dark only | Dark only | Single theme |
| Expandable create form | Yes | Yes | Yes | Yes (inline + full-screen panel) |
| Settings panel | Yes | Yes | Yes | Yes (tabbed: Agent, Merge, Profile, Project) |
| Unsaved changes guard | Unknown | Unknown | Unknown | Yes (window.confirm) |
| Mobile responsive | Unknown | Unknown | Yes | Partial |

---

## Summary Scores

| Dimension | Vibe Kanban | Lanes | Cline Kanban | Agentic Kanban |
|-----------|-------------|-------|--------------|----------------|
| Agent breadth | 10+ | 1 (+2 planned) | 7+ | 1 |
| Integration depth | Low | High (Linear, GitHub) | Medium (MCP ecosystem) | Low |
| Git sophistication | High | Medium | High (symlinks) | High (conflict detect, detached HEAD) |
| Review capability | Medium | Medium | High (multi-line comments) | High (inline comments, auto-review) |
| Testing | Unknown | None visible | None visible | High (176 tests, mock agent) |
| DX / CLI | Low | Low (brew only) | Low | High (full CLI, port strategy) |
| MCP surface | 18 tools | 27 tools | Dynamic | 27 tools |
| Autonomy | Low | Low | High (dependency chains, auto-commit) | Medium (auto-review, auto-merge setting) |
