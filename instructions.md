# Agentic Kanban — Instructions

## Prerequisites

- **Node.js** 20+ (for native SQLite support)
- **pnpm** (package manager)
- **Git** (for worktree and branch management)
- **Claude Code** CLI installed and configured (for agent-driven workflows)

## Installation & Setup

### First-time setup

```bash
pnpm install
pnpm db:setup        # runs db:migrate + db:seed + registers this repo as a project
pnpm dev             # starts server (port 3001) + client (port 5173)
```

Open http://localhost:5173. The board shows 3 active columns: **Todo**, **In Progress**, **In Review**. Completed issues (Done, Cancelled) appear in a collapsible "Completed" section.

### Registering your own project

```bash
pnpm cli -- register /path/to/your/repo
```

This detects git info (repo name, default branch, remote URL) and creates a project with 5 default statuses. You can register multiple repos and switch between them via the project dropdown in the header.

### Resetting to clean state

Stop the dev server first, then:

```bash
pnpm db:reset              # deletes DB, re-migrates, re-seeds default tags
pnpm cli -- register .     # re-register the repo
pnpm dev
```

## Managing Issues

### Creating an issue

1. Click the **+** button at the top of any column
2. Fill in the title, description, and priority
3. Click **Add** to create the issue

### Editing an issue

1. Click an issue card to open the detail panel
2. Click the edit button (pencil icon)
3. Modify title, description, or priority
4. Click **Save** to apply changes

Unsaved changes trigger a confirmation dialog before closing.

### Deleting an issue

1. Open the issue detail panel
2. Click the delete button
3. Confirm the deletion

### Moving issues between columns

**Drag and drop** — click and drag an issue card to another column.

**Status dropdown** — open the issue detail panel and use the status selector at the top.

### Searching and filtering

- Press `/` to focus the search bar
- Type to search issue titles (matches are highlighted in real-time)
- Use the priority dropdown to filter by priority
- Press `Escape` to clear the search

### Tags

Tags can be managed from the issue detail panel:

1. Open an issue
2. Click the tag dropdown
3. Select an existing tag or create a new one with a custom color
4. Click the **x** on a tag badge to remove it

Four tags are seeded by default: **bug**, **feature**, **improvement**, **docs**.

## Working with Workspaces

A workspace connects an issue to a git worktree and a Claude Code session. This is the core of the agent-driven workflow.

### Creating a workspace

1. Open an issue card
2. Click **New Workspace**
3. Configure:
   - **Branch name** — auto-suggested as `feature/<issue-number>-<title>`
   - **Base branch** — select from the dropdown (defaults to the project's default branch)
   - **Direct workspace** — check this to work directly on the main checkout (no worktree created)
4. Click create

The workspace is created in one step: git worktree + branch + Claude Code launch. The agent receives the issue title and description as its initial prompt.

### Direct workspaces

For quick tasks that don't need a separate branch:

- Check **"Work directly on main checkout"** when creating a workspace
- No worktree or branch is created — changes are made in the main repo
- Direct workspaces show a purple **direct** badge
- Use **Close** (instead of Merge) when done

### Viewing agent output

- The workspace panel shows a terminal view with live agent output streamed via WebSocket
- Use the chat input at the bottom to send messages to the agent
- Click **Send** to submit, **Stop** to interrupt a running session

### Session history

- Switch between past sessions using the inline session selector in the workspace panel
- Click **Latest** for the current session, or select a past session to view its output
- Press `Escape` to dismiss the history view

### Reviewing changes

1. Open a workspace
2. Click **View Diff** to see changes against the base branch
3. The diff viewer supports unified and split views

### Merging a workspace

1. Open the workspace
2. Click **Merge** — this merges the workspace branch into the project's default branch
3. The workspace closes automatically

For direct workspaces, click **Close** instead (no merge needed).

## Worktree Overview

Click the branch icon in the header to see all git worktrees across workspaces:

- Lists worktrees with their linked issues
- Shows diff stats (files changed, insertions, deletions)
- Displays status badges (active, idle, closed)

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `/` | Focus search bar |
| `Escape` | Clear search / close panel / dismiss dialogs |
| `Ctrl+K` | Open command palette |
| `?` | Show keyboard shortcut help overlay |
| `Ctrl+Enter` | Send message in chat input |

The command palette (`Ctrl+K`) provides a searchable list of all available actions with keyboard navigation.

## Settings

Click the gear icon in the header to open settings:

- **Agent command** — the binary used to launch the agent (default: `claude`)
- **Agent args** — additional arguments passed to the agent
- **Output parsing** — how agent output is processed for display
- **Mock agent** — toggle to use a simulated agent for testing

## MCP Server

The MCP server exposes tools for AI agent integration via stdio JSON-RPC.

### Running the MCP server

```bash
pnpm --filter @agentic-kanban/mcp-server dev
```

### Available tools

| Tool | Description |
|------|-------------|
| `getContext` | Get current project context and issue counts |
| `listIssues` | List issues with optional status filter |
| `getIssue` | Get detailed issue information |
| `createIssue` | Create a new issue |
| `updateIssue` | Update issue title, description, status, or priority |
| `listWorkspaces` | List workspaces with optional issue filter |
| `startWorkspace` | Create workspace with git worktree and start agent |
| `getWorkspaceDiff` | Get the git diff for a workspace |
| `mergeWorkspace` | Merge workspace branch and close |
| `closeWorkspace` | Close workspace without merging |

## CLI Reference

```bash
pnpm cli -- register <path>     # register a git repo as a project
pnpm cli -- list                # list registered projects (marks active)
pnpm cli -- unregister <name>   # remove a project by name or ID
pnpm cli -- cleanup             # show stale worktrees for closed workspaces
```

## Desktop App (Tauri)

If you have MSVC C++ Build Tools and Rust installed:

```bash
pnpm dev:desktop
```

This starts the server, client, and a native Tauri window with:

- **System tray** — Show/Quit options
- **Minimize to tray** — closing the window minimizes to tray
- **OS notifications** — alerts on session completion and workspace merge events

## Testing

```bash
pnpm test                # Vitest unit tests
pnpm test:e2e            # Playwright E2E tests
```

## Troubleshooting

### Port already in use

```powershell
# Kill processes on port 3001 or 5173
$proc = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($proc) { Stop-Process -Id $proc -Force }
```

### Database is locked (EBUSY)

The dev server holds the DB open. Stop all Node processes first:

```powershell
Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
```

Then retry your command.
