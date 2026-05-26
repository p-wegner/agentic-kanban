# PRD-01: Features Catalog

<!-- last-synced: 2026-05-26T12:00:00+02:00 | commit: 2e68fa0 -->

Complete inventory of features, organized by category. Status reflects the current implementation (Stages 0–14 complete).

## Category: Task Management (CORE)

### F-TASK-01: Create/Update/Delete Issues
- Issues have: title, description (markdown), priority, status
- Priorities: Urgent, High, Medium, Low
- Auto-incrementing issue numbers per project (#1, #2, #3)
- AI enhancement: "Enhance with AI" button spawns Claude CLI to improve title/description
- **Copy issue reference**: clipboard button in detail panel header copies `#N Title` reference string
- **Issue type**: Task, Bug, Feature, Chore — shown as badge in detail panel; used as filter legend in Timeline view
- **Status: DONE**

### F-TASK-02: Kanban Board View
- Visual board with columns (statuses) and draggable cards
- Statuses are per-project (Todo, In Progress, In Review, Done, Cancelled)
- **Backlog** is a special-purpose status: issues with Backlog status appear in the Backlog slide-in panel rather than a regular board column
- HTML5 drag-and-drop between columns
- Collapsible archive group for Done/Cancelled columns
- Search result highlighting on cards
- Panel slide-in animations
- Priority-based column sort: issues within each column sorted by priority
- **IssueCard hover action row**: compact action row fades in at card bottom on hover — Resume, Start Workspace, and Move to next status buttons; card body click still opens detail panel
- **Status: DONE**

### F-TASK-03: Issue Filtering & Search
- Real-time text search with highlighted matches on cards
- Priority dropdown filter in search bar
- Keyboard shortcut `/` to focus search, Escape to clear
- **Blocked filter** toggle in board stats bar — shows only issues that have a blocked_by or depends_on dependency and are not yet resolved
- **Status: DONE**

### F-TASK-04: Tags & Categories
- Create tags per project with colors
- Assign tags to issues (many-to-many)
- Removable colored badges on cards and detail panel
- 4 seed tags: bug (#EF4444), feature (#3B82F6), improvement (#8B5CF6), docs (#10B981)
- **Status: DONE**

### F-TASK-05: Issue Relationships
- 6 dependency types: depends_on, blocked_by, related_to, duplicates, parent_of, child_of
- Color-coded badges in detail panel
- "Analyze Deps" button (uses haiku model to suggest dependencies)
- Cycle detection on add
- **Status: DONE**

### F-TASK-06: Issue Assignees
- Assign issues to users
- **Status: SKIP** — single-user app, not needed

## Category: Workspace & Agent Execution (CORE)

### F-WS-01: Workspace Creation
- One-step creation: POST /api/workspaces creates DB record + git worktree + auto-launches agent
- Auto-suggested branch name: `feature/ak-<issueNumber>-<sanitized-title>`
- Base branch selection via dropdown (populated from `GET /api/projects/:id/branches`)
- Optional `skillId` for agent skill injection
- Plan mode: `--permission-mode plan` flag for read-only exploration
- **Status: DONE**

### F-WS-02: Agent Execution (Claude Code)
- Launch Claude Code in a workspace via subprocess CLI
- Stream-json output parsing (thinking blocks, tool use, tool results, model usage)
- Subagent visibility: ID-based tracking, visual indentation, styled headers
- Persistent chat input with Send/Stop toggle, Ctrl+Enter to send
- Multi-turn follow-up via `--resume` with claudeSessionId tracking
- Agent task progress on issue cards (TodoWrite/TaskCreate events via WebSocket)
- Live session stats: real-time model name and context token count on cards
- **Status: DONE**

### F-WS-03: Workspace-Issue Linking
- Workspace linked to issue for context
- Agent receives issue title + description as prompt
- Workspace summary badges on board cards (server-side aggregation)
- **Status: DONE**

### F-WS-04: Git Branch Management
- Auto-create branch per workspace via git worktree
- Branch naming conventions with sanitization
- Optional base branch for worktree creation
- Direct workspaces: work on main checkout without creating worktree
- **Status: DONE**

### F-WS-05: Workspace Deletion
- Delete workspace with confirmation dialog
- Cascade deletes sessions, session messages, diff comments
- Available for both active/idle and closed workspaces
- **Status: DONE**

### F-WS-09: Ready for Merge Badge
- Mark a workspace as ready for merge via `POST /api/workspaces/:id/mark-ready`
- `readyForMerge` field exposed on workspace GET and board endpoint workspace summary
- Green "Ready to merge" badge shown in WorkspacePanel and All Workspaces panel
- **Status: DONE**

### F-WS-06: Session Forking
- Fork an existing agent session
- **Status: NOT PLANNED** — multi-turn resume covers this need

### F-WS-07: Multi-Repo Workspaces
- Add multiple repos to a workspace
- **Status: NOT PLANNED** — single repo per workspace

### F-WS-08: Workspace Setup Scripts
- Project-specific shell commands (e.g., `pnpm install`) run automatically after worktree creation
- AI-generate button in Settings > Project tab
- Supports blocking (wait for setup before agent) and parallel modes
- **Status: DONE**

## Category: Code Review (CORE)

### F-REV-01: Diff Viewer
- Unified and split-side-by-side views
- File tree navigation
- Diff stats (+N/-N lines, files changed)
- Direct workspace diff includes untracked files
- **Status: DONE**

### F-REV-02: Inline Comments
- Create/edit/delete comments on specific diff lines
- Comments persist in `diff_comments` table
- Comment count badge in diff viewer header
- Ctrl+Enter to submit, Escape to cancel
- **Status: DONE**

### F-REV-03: AI Code Review
- Auto-review on agent session exit (configurable per issue via `skipAutoReview`)
- Manual review button in workspace panel
- Review sessions inherit `claude_profile` for gateway auth
- `review_auto_fix` setting: review agent auto-fixes findings
- Reviewing indicator badge on workspace during review
- **Status: DONE**

### F-REV-04: PR Creation
- Create PR from workspace with AI-generated description
- **Status: SKIP** — manual merge only

### F-REV-05: Preview Browser
- Built-in browser with devtools for previewing app
- **Status: SKIP** — use external browser

## Category: MCP / Agent Integration (CORE)

### F-MCP-01: MCP Server
- Model Context Protocol server for Claude Code integration
- 27 tools via stdio JSON-RPC transport
- Connected to same SQLite DB as web server
- Tools include: full CRUD + agent skills + board status + dependency management + session output + diff comments
- **Status: DONE**

### F-MCP-02: Agent Context
- Issue title + description passed as prompt to agent at workspace creation
- Project info available via `get_context` tool
- Agent can interact with board via MCP tools during execution
- **Status: DONE**

### F-MCP-03: Agent Configuration
- Configurable agent command and args (Settings panel)
- `claude_profile` setting for gateway auth
- Mock agent: built-in `mock` Claude profile (appears in Claude Profile dropdown; no separate toggle)
- `auto_merge` and `review_auto_fix` settings
- **Status: DONE**

### F-MCP-04: Agent Skills
- 4 built-in skills: board-navigator, code-review, dependency-analyzer, ticket-enhancer
- Custom skills via DB (global or project-scoped)
- Skills written as SKILL.md files in worktree for agent discovery
- CLI and MCP tools for skill management
- Skills tab in Settings panel
- **Status: DONE**

## Category: Data & Sync

### F-DATA-01: SQLite Persistence
- Local SQLite database (Drizzle ORM)
- Migration-based schema evolution (20 migrations, 13 tables)
- `__drizzle_migrations` tracking table
- **Status: DONE**

### F-DATA-02: Real-time Updates
- WebSocket `/ws/board/:projectId` for instant board change events
- WebSocket `/ws/sessions/:sessionId` for agent output streaming
- 30s polling fallback for cross-process updates (MCP, CLI, second tabs)
- MCP tools call `notifyBoard()` (fire-and-forget) for instant updates
- Session stats and task progress broadcast via WebSocket
- **Status: DONE**

### F-DATA-03: Session Persistence
- All agent output persisted to `session_messages` table
- Retrieved via `GET /api/sessions/:id/output`
- Inline session selector in workspace panel for replaying past sessions
- **Status: DONE**

### F-DATA-04: File Attachments
- Upload files to issues
- **Status: NOT PLANNED**

### F-DATA-05: Export
- Export board data
- **Status: NOT PLANNED**

## Category: UI/UX

### F-UI-01: Project/Board View
- Multi-project support with dropdown switcher in header
- Kanban board layout with collapsible column groups
- Header contains an "Unregister project" button (trash/minus icon next to project dropdown); clicking it opens a confirmation dialog: "Remove [name] from the board? This does not delete the git repository."
- **Status: DONE**

### F-UI-02: Workspace Detail View
- Slide-in panel with terminal output + diff viewer + file tree
- Inline session history selector
- Persistent chat input with multi-turn support
- Action buttons: View Diff, Terminal, Review, Merge/Close, Delete
- **Status: DONE**

### F-UI-03: Command Palette
- Ctrl+K searchable action list with keyboard navigation
- Actions grouped by category (Board, Navigation, Settings)
- Registered via `registerAction()` in `actions.ts`
- **Status: DONE**

### F-UI-04: Keyboard Shortcuts
- `/` to search, `Escape` to close/clear, `?` for help overlay
- `Ctrl+K` for command palette, `Ctrl+Enter` to send chat message to agent
- `c` to create issue, `w` to create issue + start workspace
- `q` to open Quick Tasks panel
- `b` to switch to Board view, `g` to switch to Graph view, `t` to switch to Table view, `f` to switch to Timeline view, `l` to switch to Agents view
- `g + s` to open Settings
- Help overlay (`?`) lists all shortcuts
- **Status: DONE**

### F-UI-05: Dark/Light Theme
- Moon icon button in header toggles between dark and light mode
- Preference persisted across sessions
- **Status: DONE**

### F-UI-06: Notifications
- OS notifications via Tauri (session_completed, workspace_merged)
- In-app toast notifications for CRUD actions
- **Status: DONE** (partial — OS notifications via Tauri, in-app toasts)

### F-UI-07: Worktree Overview
- Branch icon in header opens slide-in panel
- Lists all git worktrees with branch, path, issue link, diff stats, status badges
- Issue click opens detail panel and closes overview
- **Status: DONE**

### F-UI-08: Expandable Issue Creation
- Inline quick-add form per column (title, priority, Add/Cancel)
- Full-screen panel via Expand button (title, description, priority, start workspace, plan mode, skip review)
- **Status: DONE**

### F-UI-09: Settings Panel
- Tabbed modal (gear icon in header), 9 tabs:
  - **Agent**: agent command/binary, Claude profile (--settings flag), additional CLI args
  - **Workflow**: pipeline visualization (Agent runs → AI Review → Auto-fix → Auto-merge → Merge); auto code review, auto-fix, auto-merge toggles; "Use new profile on resume" toggle — starts a fresh session with the current Claude profile instead of resuming the previous session; **Board Monitoring** feature also surfaces in the board header toolbar (next to Backlog/Tasks buttons) as a "Monitor" toggle button and a "Run monitor now and reset timer" play button; Persistent agent (warm pool) toggle; "Auto-continue after plan (Codex)" checkbox — when Codex plan-mode run finishes, saves to PLAN.md; if on, auto-starts implementation turn; if off, waits for "Accept & Implement"; "Require manual approval before review" checkbox — gates AI review on human sign-off; "Visual verification timing" dropdown — "Before merge (default)" or "After merge"; controls when UI changes are verified via browser snapshot; **Learning steps** section with 3 checkboxes: "Learning step after agent (parallel)", "Learning step after review (parallel)", "Learning step before merge (blocking)"
  - **Skills**: list of global + project-scoped skills with install status; Edit buttons
  - **MCP Tools**: MCP server configuration and tool list
  - **UI**: output parsing mode (Minimal/Full), Dynamic column scaling toggle
  - **Project**: projects base directory, setup script (textarea + AI-generate button)
  - **Tags**: manage tags (rename, delete, merge); Add new tag
  - **Schedule**: configure recurring agent runs — name, prompt, interval in minutes; list of scheduled runs; empty state text
  - **Advanced**: Skip Permissions (--dangerously-skip-permissions), Permission Prompt Tool
- **Status: DONE**

### F-UI-10: Board Views
- Five view modes: Board (kanban columns), Graph (dependency DAG), Table (flat sortable list), Agents, Timeline
- Table view: sortable columns (#, Title, Status, Priority, Type, Estimate, Updated, Tags); **Active only** default filter (dropdown: Active only, All); row click opens detail panel
- Graph view: nodes colored by status, dependency arrows, "Show completed" toggle, zoom controls (+/−/reset), status legend
- Agents view: lists active agent sessions across workspaces
- Timeline view: all issues as horizontal bars on a chronological timeline, grouped into per-status swim lanes; each bar spans createdAt->updatedAt; color-coded by issue type (task=blue, bug=red, feature=violet, chore=amber) with a priority-colored dot; sticky date axis with tick marks and a red 'Today' marker; zoom controls (50%-500%); hover tooltip showing #, created/updated dates, type, priority, tags; click a bar to open the issue detail panel; issue-type legend; empty state when no issues match; dark mode support
- View toggle buttons in board header
- **Status: DONE**

### F-UI-11: Board Stats Bar
- Ticket counts per status (Todo N, In Progress N, In Review N, AI Reviewed N, N done)
- **Circular progress ring** showing total ticket count and percentage done (e.g. "207 tickets 93%")
- **Horizontal proportional color bar** under the stats row showing relative counts per status (Todo/In Progress/In Review/Done/Cancelled colored segments)
- Commits on main branch counter (e.g. "640 commits")
- Blocked filter toggle — hides all non-blocked issues
- Tasks button — opens Quick Tasks panel (skill launcher)
- **Active profile badge** (e.g. "anth 12"): shows current Claude profile name and count of active sessions using it; also appears inline next to the workspace branch on issue cards when that profile is active
- **Status: DONE**

### F-UI-12: Quick Tasks Panel
- Slide-in panel listing all installed skills (board-navigator, code-review, dependency-analyzer, ticket-enhancer, ui-explorer, + custom)
- Each skill shows name, description, and model badge (if haiku/non-default)
- Custom task prompt input (free-form agent prompt)
- Context button to attach board context
- **Status: DONE**

### F-UI-13: Scheduled Runs (Settings → Schedule tab)
- Configure recurring agent runs
- Each scheduled run creates a direct workspace on its system issue at the configured interval
- Form fields: Name (e.g. "Daily standup update"), Prompt for the agent, Interval (minutes, default 60)
- Empty state: "No scheduled runs configured yet."
- **Status: DONE**

### F-UI-14: All Workspaces Panel
- Slide-in panel (header "All Workspaces" icon) listing workspaces across all active issues
- Search input: filter by title or branch name
- Status filter tabs: All, Active, Running, Idle, Reviewing, Fixing, Closed
- Empty state with helpful prompt
- **Status: DONE**

### F-UI-16: Agents View
- 4th board view tab (after Table)
- Shows live agent activity across all running workspaces
- "No active agents" empty state with link to start a workspace
- **Status: DONE**

### F-UI-17: Timeline View
- 5th board view tab (after Agents)
- Gantt-style chart of all issues grouped by status (e.g. Backlog, Done)
- Each issue shown as a horizontal bar on a time axis
- Header: "N issues across M statuses"
- Zoom controls: −/100%/+
- Tag type legend: Task, Bug, Feature, Chore (filter bars by type)
- "Today" marker on time axis
- Horizontal scrollbar for navigating time range
- **Status: DONE**

### F-UI-15: Backlog Panel
- Slide-in panel triggered by "Backlog N" count button in board toolbar
- "Drop issues here to move to Backlog" drag-drop target area at the top of the panel
- "Backlog is empty" empty state when no issues have Backlog status
- Issues with Backlog status appear here; dragging an issue from the board drops it into the Backlog panel
- **Status: DONE**

## Category: Infrastructure

| Feature | Original | Our Decision |
|---------|----------|-------------|
| Multi-tenant / Orgs | Full RBAC | SKIP — single user |
| Cloud deployment | PostgreSQL + ElectricSQL | SKIP — local only |
| Tauri desktop app | Native wrapper | DONE — Tauri v2 with system tray + OS notifications |
| Multiple agents | 10 executors | SKIP — Claude Code only |
| Relay / WebRTC | Tunnel system | SKIP |
| OAuth (GitHub/Google) | Full OAuth | SKIP — local auth |
| Billing | Feature-gated | SKIP |
| Analytics (PostHog) | Full tracking | SKIP |
| Error tracking (Sentry) | Full integration | SKIP — structured console logging |
| i18n | Multi-language | SKIP — English only |
| Mobile | Tailscale setup | SKIP — desktop only |
| Preview proxy | Built-in browser | SKIP — use external |
| Embedded SSH | SSH operations | SKIP |
| Desktop bridge | Tauri bridge | SKIP — direct Tauri integration |
| PR creation | AI descriptions | SKIP — manual merge only |
