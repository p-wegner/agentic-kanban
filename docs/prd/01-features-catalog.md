# PRD-01: Features Catalog

Complete inventory of features discovered in the original vibe-kanban, organized by category.

## Category: Task Management (CORE)

### F-TASK-01: Create/Update/Delete Issues
- Issues have: title, description (markdown), priority, status, assignees
- Priorities: Urgent, High, Medium, Low
- **Priority: MUST** - fundamental to the kanban concept

### F-TASK-02: Kanban Board View
- Visual board with columns (statuses) and draggable cards
- Statuses are per-project configurable (Todo, In Progress, In Review, Done, Cancelled)
- Drag-and-drop between columns
- **Priority: MUST**

### F-TASK-03: Issue Filtering & Search
- Filter by status, priority, assignees, tags
- Sort by order, priority, created/updated date, title
- Text search across issues
- **Priority: MUST** (basic), LATER (advanced)

### F-TASK-04: Tags & Categories
- Create tags per project
- Assign tags to issues (many-to-many)
- **Priority: SHOULD**

### F-TASK-05: Issue Relationships
- Parent/child (sub-issues)
- Blocking, related, duplicate relationships
- **Priority: LATER**

### F-TASK-06: Issue Assignees
- Assign issues to users
- Filter by assignee
- **Priority: LATER** (single-user first)

## Category: Workspace & Agent Execution (CORE)

### F-WS-01: Workspace Creation
- Each workspace = isolated git branch + working directory
- Can be created from an issue ("start working on this")
- Workspace has: name, branch, repos, status
- **Priority: MUST**

### F-WS-02: Agent Execution (Claude Code)
- Launch Claude Code in a workspace
- Real-time terminal output streaming (xterm.js)
- Session management (create, list, stop)
- **Priority: MUST**

### F-WS-03: Workspace-Issue Linking
- Link workspace to issue for context
- Agent receives issue title/description as prompt context
- **Priority: MUST**

### F-WS-04: Git Branch Management
- Auto-create branch per workspace
- Branch naming conventions
- **Priority: MUST**

### F-WS-05: Workspace Deletion
- Delete workspace from WorkspacePanel with confirmation dialog
- Cascade deletes sessions, session messages, and diff comments
- Available for both active/idle and closed workspaces
- **Priority: MUST**

### F-WS-06: Session Forking
- Fork an existing agent session
- **Priority: LATER**

### F-WS-07: Multi-Repo Workspaces
- Add multiple repos to a workspace
- Setup/cleanup scripts per repo
- **Priority: SHOULD**

## Category: Code Review (CORE)

### F-REV-01: Diff Viewer
- View git diffs for workspace changes
- Side-by-side or unified diff view
- File tree navigation
- **Priority: MUST**

### F-REV-02: Inline Comments
- Leave comments on specific lines of code
- Send feedback back to agent
- **Priority: SHOULD**

### F-REV-03: PR Creation
- Create PR from workspace with AI-generated description
- Push to GitHub/GitLab
- **Priority: SHOULD**

### F-REV-04: Preview Browser
- Built-in browser with devtools for previewing app
- Device emulation
- **Priority: LATER** (use external browser)

## Category: MCP / Agent Integration (CORE)

### F-MCP-01: MCP Server
- Model Context Protocol server for Claude Code integration
- Tools: create_issue, list_issues, update_issue, get_context, etc.
- Two modes: global (full access) and orchestrator (scoped)
- **Priority: MUST**

### F-MCP-02: Agent Context
- Provide issue/workspace/session context to agent
- Project info, linked repos, branch status
- **Priority: MUST**

### F-MCP-03: Agent Configuration
- Per-executor config (model, env vars, prompts)
- JSON schema-based configuration
- **Priority: SHOULD** (Claude Code only first)

## Category: Data & Sync

### F-DATA-01: SQLite Persistence
- Local SQLite database for all data
- Migrations for schema evolution
- **Priority: MUST**

### F-DATA-02: Real-time Updates
- WebSocket-based real-time sync
- Live updates when agent modifies state
- **Priority: SHOULD**

### F-DATA-03: File Attachments
- Upload files to issues
- Image preview
- **Priority: LATER**

### F-DATA-04: Export
- Export board data
- **Priority: LATER**

## Category: UI/UX

### F-UI-01: Project/Board View
- Multiple projects
- Kanban board layout
- **Priority: MUST**

### F-UI-02: Workspace Detail View
- Terminal + diff viewer + file tree
- Resizable panels
- **Priority: MUST**

### F-UI-03: Command Palette
- Quick actions via keyboard shortcut (Cmd+K)
- **Priority: SHOULD**

### F-UI-04: Keyboard Shortcuts
- Common actions accessible via keyboard
- **Priority: SHOULD**

### F-UI-05: Dark/Light Theme
- Theme switching
- **Priority: SHOULD**

### F-UI-06: Notifications
- In-app notifications for events
- **Priority: LATER**

## Category: Infrastructure (SKIP for MVP)

| Feature | Original | Our Decision |
|---------|----------|-------------|
| Multi-tenant / Orgs | Full RBAC | SKIP - single user |
| Cloud deployment | PostgreSQL + ElectricSQL | SKIP - local only |
| Tauri desktop app | Native wrapper | SKIP - web app |
| Multiple agents | 10 executors | SKIP - Claude Code only |
| Relay / WebRTC | Tunnel system | SKIP |
| OAuth (GitHub/Google) | Full OAuth | SKIP - local auth |
| Billing | Feature-gated | SKIP |
| Analytics (PostHog) | Full tracking | SKIP |
| Error tracking (Sentry) | Full integration | SKIP |
| i18n | Multi-language | SKIP - English only |
| Mobile | Tailscale setup | SKIP - desktop only |
| Preview proxy | Built-in browser | SKIP - use external |
| Embedded SSH | SSH operations | SKIP |
| Desktop bridge | Tauri bridge | SKIP |
