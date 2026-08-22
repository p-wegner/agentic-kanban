---
commit: 8a8b21cc0a078681d28d7afe5cf77e0456f8a861
generated: 2026-07-23T05:05:54.762Z
features_count: 51
source: "packages/client/src, packages/server/src, packages/mcp-server/src, docs/prd"
---

# Agentic Kanban — User Manual

> A personal kanban board for AI-driven coding work. Plan tasks, launch AI agents, review diffs, and merge — all from one interface.

<!-- screenshot: main board view -->

## Table of Contents

1. [Installation & Setup](#installation-setup)
2. [Core Workflow](#core-workflow)
3. [Issue Management](#issue-management)
4. [Board Views](#board-views)
5. [Workspaces & Agents](#workspaces-agents)
6. [Code Review & Merge](#code-review-merge)
7. [Butler Assistant](#butler-assistant)
8. [Settings Reference](#settings-reference)
9. [Keyboard Shortcuts](#keyboard-shortcuts)
10. [CLI Reference](#cli-reference)
11. [MCP Tools](#mcp-tools)
12. [Monitoring & Automation](#monitoring-automation)
13. [Desktop App](#desktop-app)
14. [Troubleshooting](#troubleshooting)


## Installation & Setup

### Prerequisites

| Requirement | Version | Install |
|-------------|---------|---------|
| [Node.js](https://nodejs.org/) | 22+ (LTS 22 recommended) | `winget install OpenJS.NodeJS.LTS` |
| [pnpm](https://pnpm.io/) | 10.12.1 | `corepack enable && corepack prepare pnpm@10.12.1 --activate` |
| [Git](https://git-scm.com/) | 2.20+ | `winget install Git.Git` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | latest | `npm install -g @anthropic-ai/claude-code` |

> **Tip:** Node.js LTS 20 or 22 is recommended. Node 23.x has a known issue where `tsx watch` hangs on Windows.

### Verify your installation

```bash
node --version      # v20.x or later
pnpm --version      # 10.12.1
git --version
claude --version
```

### Install & first run

```bash
git clone https://github.com/p-wegner/agentic-kanban.git
cd agentic-kanban
pnpm install        # also builds shared packages
pnpm db:setup       # migrate + seed tags/skills + register this repo
pnpm dev            # server on :3001, client on :5173
```

Open **http://localhost:5173** in your browser.

<!-- screenshot: fresh board after first run -->

### Register another project

To manage tasks for a different repository:

```bash
pnpm cli -- register /path/to/your/repo
```

This detects the git metadata and creates a project with default statuses. Switch between projects using the dropdown in the header.

<!-- screenshot: project dropdown in header -->

## Core Workflow

The basic loop:

**Create issue → Start workspace → Agent works → Review diff → Merge**

### Step 1: Create an issue

1. Press `c` or click the **+** button in any column
2. Enter a title and optional description
3. Set priority (Urgent, High, Medium, Low) and type (Task, Bug, Feature, Chore)
4. Click **Add**

<!-- screenshot: issue creation form -->

### Step 2: Start a workspace

1. Click the issue card on the board
2. Click **Start Workspace** in the detail panel
3. The system creates an isolated git worktree and launches an AI agent

You can also press `w` to create an issue and start a workspace in one step.

<!-- screenshot: workspace creation from issue detail -->

### Step 3: Agent works

The AI agent (Claude, Codex, or Copilot) reads the issue description and starts implementing. You can:

- Watch real-time output in the workspace panel
- Send follow-up messages via the chat input
- See live session stats (model, tokens, cost)

<!-- screenshot: workspace panel with agent output -->

### Step 4: Review the diff

When the agent finishes:

1. Click **View Diff** in the workspace panel
2. Browse changed files in the diff viewer
3. Add inline comments on specific lines
4. Optionally trigger an AI code review

<!-- screenshot: diff viewer -->

### Step 5: Merge

1. Click **Merge** to land the changes on your default branch
2. The workspace closes and the issue moves to **Done**

If auto-merge is enabled, the system can merge automatically after review.

<!-- screenshot: merge button in workspace panel -->

## Issue Management

### Create an issue

- **Quick add:** Press `c` to open an inline form in the first column
- **Full form:** Click the **+** button or use the expand icon for more options (description, priority, start workspace, plan mode)
- **CLI:** `pnpm cli -- issue create "Fix login bug" -p High -t Bug`

### Edit an issue

- Click the issue card to open the detail panel
- Click **Edit** from the Actions menu (or the pencil icon)
- Modify title, description, priority, status, or type
- Changes save automatically

### Issue types

| Type | Use for |
|------|----------|
| Task | General work items |
| Bug | Defects and issues to fix |
| Feature | New functionality |
| Chore | Maintenance, refactoring, tooling |

### Priorities

| Priority | Badge color |
|----------|-------------|
| Urgent | Red |
| High | Orange |
| Medium | Blue |
| Low | Gray |

### Tags

- Assign colored tags to issues for categorization
- Create custom tags in **Settings > Tags**
- Filter issues by tag on the board
- Default tags: bug (red), feature (blue), improvement (purple), docs (green)

### Dependencies

Link related issues with dependency types:

| Type | Meaning |
|------|---------|
| depends_on | This issue requires the other to be done first |
| blocked_by | This issue is blocked until the other is resolved |
| related_to | Loose association |
| duplicates | Same work as another issue |
| parent_of | Parent epic |
| child_of | Child task of an epic |

Add dependencies from the issue detail panel or via the CLI:

```bash
pnpm cli -- issue dependency add 5 3 -t depends_on
```

### Estimates

- Use T-shirt sizing: XS, S, M, L, XL
- Click the estimate buttons in the detail panel, or
- Click **AI** to let the agent suggest an estimate

### AI Enhancement

Click **Enhance with AI** to have the agent improve your issue title and description for clarity.

### Bulk operations

In **Table view**, select multiple issues using checkboxes to:

- Move to a different status
- Add a tag
- Delete selected issues

### Copy issue reference

Click the clipboard button in the detail panel header to copy `#N Title` — a reference string you can paste elsewhere.

### Decompose epics

The **Decompose** action (in the Actions menu) uses AI to split a large ticket into linked child tickets.

<!-- screenshot: issue detail panel with all controls -->

## Board Views

Switch between views using the toolbar tabs, the command palette (`Ctrl+K`), or keyboard shortcuts.

### View shortcuts

| View | Key | Action |
|------|-----|--------|
| **Board** | `b` | Switch to this view |
| **Backlog** | `r` | Switch to this view |
| **Graph** | `g` | Switch to this view |
| **Table** | `t` | Switch to this view |
| **Agents** | `l` | Switch to this view |
| **Timeline** | `f` | Switch to this view |
| **Metrics** | `m` | Switch to this view |
| **Quality Metrics** | `y` | Switch to this view |
| **Standup Digest** | `d` | Switch to this view |
| **Strategic Targets** | `z` | Switch to this view |
| **Focus** | `o` | Switch to this view |
| **Butler chat** | `i` | Switch to this view |
| **Workflows** | `u` | Switch to this view |
| **Workflow Analytics** | `h` | Switch to this view |
| **Insights** | `n` | Switch to this view |
| **Swimlane** | `p` | Switch to this view |
| **Flaky Tests Radar** | `k` | Switch to this view |
| **Runbooks** | `j` | Switch to this view |
| **Momentum** | `v` | Switch to this view |
| **Constellation** | `e` | Switch to this view |

### Board (Kanban)

The default view. Issues displayed as cards in status columns. Drag and drop cards between columns to change status. Columns are grouped into active (Todo, In Progress, In Review) and archive (Done, Cancelled).

<!-- screenshot: kanban board view -->

### Backlog

A dedicated view for planning and triaging. Issues with Backlog status appear here. Drag issues from the board into the Backlog panel, or create new ones directly in the Backlog.

### Graph

Dependency DAG visualization. Nodes are colored by status with arrows showing dependency relationships. Toggle "Show completed" to include done issues. Zoom controls for large graphs.

### Table

Flat sortable list of all issues. Sort by any column (number, title, status, priority, type, estimate, due date, updated, tags). Use the status filter dropdown to focus on active issues. Select multiple rows for bulk operations.

### Timeline

Gantt-style chart showing issues on a chronological timeline grouped by status lanes. Each bar spans from creation to last update. Color-coded by issue type. Zoom controls and a "Today" marker.

### Agents

Live grid showing all active agent sessions across workspaces. See which agents are running, their status, and session stats at a glance.

### Metrics

Aggregate project metrics: total issues, active count, completion rate, blocked issues. Charts for status distribution, priority breakdown, type breakdown, and a GitHub-style contribution heatmap.

### Insights

Agent performance analytics: total sessions, success rate, total cost, total tokens. Breakdowns by skill, model, issue type, and priority. Daily cost trend chart. Top 10 most expensive sessions.

### Swimlane

Priority x status matrix. Issues placed in the cell matching their priority band and status column. Collapsible priority bands (Critical, High, Medium, Low).

### Workflows

Design ticket-type pipelines as configurable stage graphs. Built-in workflows: Simple Ticket, Simple Bug, Hard Bug, Research Task, Migration with AI, Parallel Review. Visual DAG editor for custom workflows.

### Standup Digest

"What changed on the board while you were away." Toggle between 24h, 3 days, and 7 days. Shows created, completed, merged, agent runs, and blocked issues.

### Flaky Tests Radar

Track intermittent test failures. Time-window filtering (7d/30d/90d). Shows pass/fail patterns across sessions.

### Focus

"What should I work on next?" A prioritized view of the most impactful next task based on dependencies, priority, and board state.

### Quality Metrics

Code quality metrics collected from agent sessions. Track complexity, churn, and other quality signals over time.

### Strategic Targets

Weighted focus board mapping strategic directions onto target areas. Track progress toward strategic goals.

### Constellation

Immersive radial starfield view. Issues as glowing nodes orbiting status clusters.

### Momentum

Priority-lane river view. Issues flowing through workflow progress within priority bands.

### Runbooks

Browse project documentation: CLAUDE.md, learnings, decisions, and the board-monitor runbook.

## Workspaces & Agents

A workspace is the atomic unit of agent work: a git worktree + branch + agent session bound to an issue.

### Create a workspace

1. Open an issue detail panel
2. Click **Start Workspace**
3. Choose options:
   - **Base branch** — which branch to create the worktree from
   - **Agent skill** — optional skill to inject
   - **Plan mode** — read-only exploration mode
   - **Skip review** — skip auto-review after agent finishes

The system creates an isolated git worktree and launches the agent.

<!-- screenshot: workspace creation dialog -->

### Workspace states

| State | Meaning |
|-------|---------|
| Running | Agent is actively working |
| Idle | Agent finished, workspace ready for review |
| Reviewing | AI code review in progress |
| Fixing | Auto-fix in progress |
| Closed | Workspace archived (merged or abandoned) |

### Resume an agent

If an agent stopped or you want to continue work:

1. Open the workspace panel
2. Click **Resume** or type a follow-up message in the chat input
3. The agent continues from where it left off

### Multi-turn chat

Send follow-up messages to a running or idle agent:

- Type in the chat input at the bottom of the workspace panel
- Press `Ctrl+Enter` to send
- The agent receives your message and continues working

### View agent output

The workspace panel shows:

- **Terminal** — real-time agent output with tool calls and results
- **Diff** — the current git diff of changes
- **Sessions** — history of past agent sessions for this workspace
- **Stats** — model name, tokens used, cost

### Agent providers

Choose between different AI coding agents:

| Provider | Notes |
|----------|-------|
| Claude Code | Default. Uses your Anthropic subscription. |
| Codex | OpenAI's Codex agent |
| Copilot | GitHub Copilot agent |
| Pi | Alternative CLI agent |

Select the provider in **Settings > Agent** or per-workspace at launch.

### Delete a workspace

Open the workspace detail panel > Actions menu > **Delete**. This removes the worktree, all sessions, and associated data. The git branch is preserved.

## Code Review & Merge

### Diff viewer

After an agent finishes, the workspace shows a diff of all changes:

- **Unified view** — standard diff format
- **Split view** — side-by-side comparison
- **File tree** — navigate changed files
- **Stats** — files changed, lines added/removed

<!-- screenshot: diff viewer -->

### Inline comments

1. Click the **+** button on a diff line
2. Type your comment
3. Press `Ctrl+Enter` to save

Comments are saved and visible to the agent on resume.

### AI code review

Trigger an automatic AI review that checks for:

- Correctness bugs
- Security vulnerabilities
- Logic errors
- Missing error handling

Findings are classified as CRITICAL, MAJOR, or MINOR. Enable auto-review in **Settings > Workflow > Auto Code Review**.

### Auto-fix

When enabled, the review agent automatically fixes its own findings and commits the changes. Enable in **Settings > Workflow > Auto-fix issues found in review**.

### Merge

When satisfied with the changes:

1. Click **Merge** in the workspace panel
2. The branch is merged into the default branch
3. The issue moves to **Done**
4. The workspace is closed

If auto-merge is enabled, this happens automatically after review passes.

### Merge strategies

| Strategy | Behavior |
|----------|----------|
| Direct/manual | Merge on explicit click |
| Monitor | Automated monitor decides when to merge |
| Merge queue | Queued merges with conflict detection |

## Butler Assistant

The Butler is a warm, persistent AI assistant that lives in your project. Unlike per-task agents, the Butler maintains context across conversations.

### Open Butler

- Press `i` to switch to the Butler view
- Or click the Butler tab in the view switcher

<!-- screenshot: Butler chat view -->

### What can Butler do?

- Answer questions about the codebase
- Help plan and decompose tasks
- Orchestrate board operations (create issues, start workspaces)
- Explain past agent sessions
- Provide architectural guidance

### Chat

Type your message and press Enter. The Butler streams its response in real-time with tool activity visible.

### Slash commands

Type `/` in the chat input to see available commands. These include skills installed in the project.

### Customize the Butler

Click **Customize** in the Butler view to edit the project-specific prompt. This shapes how the Butler behaves for your project.

### Model & profile

- **Model picker** — switch between Opus, Sonnet, Haiku without restarting
- **Profile picker** — switch Claude profile (restarts the session)
- **Stop button** — interrupt an in-flight turn

### Keyboard shortcuts (Butler view)

| Keys | Action |
|------|--------|
| `Enter` | Send message |
| `Ctrl+Enter` | Send message |
| `Shift+Enter` | Insert newline |
| `Ctrl+Space` | Hold to dictate |
| `Ctrl+L` | Clear context |
| `Ctrl+P` | Cycle profile |
| `Ctrl+M` | Cycle model |
| `Ctrl+Shift+N` | New session |

## Settings Reference

Open Settings with `g` then `s`, or click the gear icon in the header.

<!-- screenshot: settings panel -->

### Agent

- Agent command/binary
- Provider for this project (dropdown)
- Agent Profile (dropdown)
- Default Model (dropdown)
- Additional CLI arguments

### Workflow

- Pipeline visualization
- Auto Code Review toggle
- Auto-fix issues toggle
- Auto-merge after review toggle
- Merge strategy (dropdown)
- Visual verification timing (dropdown)
- Learning steps (3 toggles)
- Auto-start follow-up tasks toggle
- Board Monitor settings

### Skills

- Skill list with edit/delete/install
- Create new skill
- Edit skill prompt
- Model override per skill

### MCP Tools

- MCP connection health probe
- Server info display
- Per-tool enable/disable toggles

### UI

- Output parsing mode (dropdown)
- Dynamic column scaling toggle

### Project

- Projects base directory
- Default Branch
- Project Color
- Stack Profile
- Setup Script (textarea + AI generate)
- Run setup before agent toggle
- Dependency Symlinks toggle
- Teardown Script
- Verify Script

### Tags

- Tag list with edit/delete/merge
- Create new tag (name + color)

### Templates

- Template list (built-in + custom)
- Edit/create/delete templates

### Schedule

- Scheduled runs list
- Add new scheduled run (name, prompt, interval)
- Trigger now button

### Advanced

- Skip Permissions toggle
- Permission Prompt Tool toggle



## Keyboard Shortcuts

Press `?` to open the keyboard shortcuts overlay at any time.

<!-- screenshot: keyboard shortcuts overlay -->

### Navigation

| Keys | Action |
|------|--------|
| `/` | Focus search |
| `Ctrl+K` | Command palette |
| `Escape` | Close panel / clear search / go back |
| `?` | Show keyboard shortcuts |

### Board

| Keys | Action |
|------|--------|
| `↑/↓/k/j` | Move selection up / down within column |
| `←/→/h/l` | Move selection left / right across columns (h/l when card selected) |
| `Enter` | Open selected card's detail panel |
| `w` | New issue + start workspace |
| `Shift+V` | Start voice inbox (record idea → Backlog issue) |
| `g then s` | Open settings |

### Panels

| Keys | Action |
|------|--------|
| `a` | Toggle All Workspaces panel |
| `q` | Open Quick Tasks panel |
| `x` | Open Codemod Factory |
| `l` | Toggle Live Activity ticker (no card selected) |

### Views

| Key | View |
|-----|------|
| `b` | Board |
| `r` | Backlog |
| `g` | Graph |
| `t` | Table |
| `l` | Agents |
| `f` | Timeline |
| `m` | Metrics |
| `y` | Quality Metrics |
| `d` | Standup Digest |
| `z` | Strategic Targets |
| `o` | Focus |
| `i` | Butler chat |
| `u` | Workflows |
| `h` | Workflow Analytics |
| `n` | Insights |
| `p` | Swimlane |
| `k` | Flaky Tests Radar |
| `j` | Runbooks |
| `v` | Momentum |
| `e` | Constellation |


## CLI Reference

The CLI is available via `pnpm cli --` from the repo root, or `agentic-kanban` if installed globally.

| Command | Description |
|---------|-------------|
| `register [path]` | Register a git repo as a project |
| `create <folder>` | Create a new git repo and register it |
| `status` | Show board status overview |
| `init [path]` | Initialize for first time |
| `install-skill [path]` | Install built-in agent skills |
| `issue list [-s status] [-p priority]` | List issues |
| `issue get <number>` | Show issue details |
| `issue create <title> [-p priority] [-t type]` | Create an issue |
| `issue update <issue> [-t title] [-d desc] [-s status]` | Update an issue |
| `issue move <id> <status>` | Move issue to a status |
| `issue delete <number>` | Delete an issue |
| `issue create-sub <parent> <title>` | Create a child issue |
| `issue dependency add <id> <target> [-t type]` | Add a dependency |
| `issue dependency remove <dep-id>` | Remove a dependency |
| `workspace list` | List workspaces |
| `workspace create <issue-id> [-b base]` | Create workspace for issue |
| `workspace resume <issue-number>` | Resume workspace for issue |
| `workspace launch <id>` | Launch idle workspace |
| `workspace review <id>` | Trigger AI code review |
| `workspace merge <id>` | Merge workspace branch |
| `workspace diff <id>` | Get workspace git diff |
| `workspace scorecard <id>` | Get PR quality scorecard |
| `workspace close <id>` | Close workspace without merging |
| `workspace delete <id>` | Delete workspace and data |
| `workspace stop <id>` | Stop running agent session |
| `workspace terminal <id> [-n last]` | Read agent session output |
| `butler ask <question>` | Ask butler a question |
| `butler ensure` | Start butler warm session |
| `butler stop` | Stop butler session |
| `butler state` | Print butler current state |
| `project list` | List registered projects |
| `project unregister <name>` | Remove a project |
| `skill list` | List agent skills |
| `skill create <name>` | Create a new agent skill |
| `tag list` | List tags |
| `tag create <name> --color <hex>` | Create a tag |


## MCP Tools

The MCP server exposes 94 tools for AI agents to interact with the board. These are available to Claude Code and other MCP-compatible agents.

| Tool | Description |
|------|-------------|
| `get_context` | Get current project context including project info, issues count by status, and active workspaces |
| `get_board_status` | Get a comprehensive overview of all active/in-progress items on the board. Shows per-issue: workspace state, session status, diff stats, token/cost usage, and last agent output. This is the single best query to answer 'what are my agents doing right now?' |
| `get_board_risk_digest` | Get a risk digest of the current board state. Summarizes merge blockers (conflicts or idle In-Review), stale sessions (error or running with no activity for 2+ hours), low backlog risk, and board health issues needing attention. Returns counts and the top 3 actionable items with issue numbers and short reasons. Use this when a user asks about board risks, blockers, or health. |
| `find_similar_failures` | Search the failure-pattern memory for past incidents similar to a given error text. Returns top matches with root-cause and fix information. Use this when an agent session fails or encounters errors to find known solutions. |
| `delete_status` | Delete a project status. Fails if any issues are linked to it. |
| `list_issues` | List all issues for a project, optionally filtered by status name, priority, tag, blocked status, or issue number |
| `get_issue` | Get detailed information about a specific issue, including workspaces and dependencies. Accepts either a UUID issue ID or a numeric issue number (e.g. 42). When resolving by number, pass projectId to scope to the correct project. |
| `get_issue_summary` | Get a summary of the latest completed agent session for an issue. Resolves issue number → workspace → latest session → parsed summary in one call. Shows agent summary text, files touched, commands run, duration, cost, and key excerpts. Complements get_board_status (live state) with completed-work history. |
| `create_issue` | Create a new issue on the kanban board |
| `create_sub_issue` | Create one child issue and link it to a parent with a child_of dependency in the same transaction. |
| `create_issues_batch` | Create multiple issues atomically in a single call, optionally with dependency edges between them. Returns each created issue with its assigned issueNumber. All-or-nothing: issues AND edges commit in one transaction, so autodrive can never observe a ticket before its dependency edges exist. Any validation failure rolls back. |
| `update_issue` | Update an existing issue (title, description, status, priority, type) |
| `delete_issue` | Delete an issue and all its associated data |
| `move_issue` | Move an issue to a different status column by name (e.g., 'Todo', 'In Progress', 'Done') |
| `attach_artifact` | Attach a text, link, image, or video artifact to an issue or workspace. Workspace artifacts are also tied to the workspace's issue. |
| `check_issue_overlap` | Check which files overlap between a set of issues based on their cached touched-file predictions. Returns a map of filePath → [issueIds] for files touched by more than one issue. Run analyze_touched_files on each issue first to populate the cache. Use before launching parallel workspaces to detect conflict risk. |
| `analyze_touched_files` | Predict which source files an issue will likely modify using a fast AI model. Results are cached on the issue. Re-running with refresh=true forces a new prediction. |
| `list_workspaces` | List workspaces, optionally filtered by issue ID |
| `start_workspace` | Create a worktree-only workspace record for an issue (no agent, no status change). This does NOT launch an agent or move the issue to In Progress. To actually START work on an issue (worktree + move to In Progress + launch the agent in one step), POST to the board's /api/workspaces endpoint instead. Use this tool only when you explicitly want a bare worktree. |
| `launch_workspace` | Launch (or re-launch) a workspace's agent session. Mirrors CLI `workspace launch <workspace-id>`. Auto-builds the prompt from the issue title+description when no prompt is supplied. The server enforces that the workspace must be idle before launch. Prefer relaunch_workspace when you already have a custom prompt ready; use this tool when you want the default issue-derived prompt. |
| `relaunch_workspace` | Relaunch an idle workspace by starting a new agent session. The workspace must be in 'idle' status. |
| `wait_workspace` | Poll until the latest workspace for an issue reaches a terminal status (idle, ready_for_merge, closed, merged, error, or failed). Mirrors CLI `workspace wait <issue-number>` but uses a bounded DB poll instead of a WebSocket subscription so it always returns within maxWaitSeconds. Use this after launching a workspace to know when the agent is done. Returns the final status and a result field ('success' | 'error' | 'timeout'). |
| `get_workspace_diff` | Get the git diff for a workspace's working directory |
| `get_workspace_scorecard` | Get the PR quality scorecard for a workspace. Returns a 0-100 score with per-dimension breakdown (Tests, Types, Scope, Diff size, Conflicts, Docs, Skill output). |
| `merge_workspace` | Merge a workspace branch into the project's default branch, close the workspace, and auto-transition the issue to Done. Delegates to the board server's safe merge path — per-repo merge lock, pre-merge backup/rollback, OpenSpec delta application, and conflict detection with fix-and-merge recovery — so an MCP merge has the same safety net as the UI. Requires the board server to be running. |
| `close_workspace` | Close a workspace without merging. For direct workspaces or abandoned work. Use merge_workspace instead if you want to merge the branch. |
| `mark_ready_for_merge` | Mark a workspace as reviewed and ready to merge. Call this after a successful code review with no critical or major issues. This flag allows future agents to merge the workspace without requiring another review. |
| `stop_workspace` | Stop any running agent session for a workspace |
| `delete_workspace` | Delete a workspace and all its associated data |
| `export_handoff_bundle` | Export a compact handoff bundle for a workspace that is stuck, awaiting review, or being transferred to a human. Returns workspace metadata, issue context, diff stats, agent summary, changed files, errors, and reviewer notes. |
| `list_sessions` | List all sessions for a workspace, including status and timing |
| `recent_sessions` | List the most recent agent sessions across all workspaces with metadata (status, executor, workspace, issue). Mirrors `pnpm cli -- session recent`. |
| `read_terminal` | Read agent session output (terminal messages) for a session. Returns the last N messages, stripped of ANSI codes. |
| `get_session_transcript` | Retrieve a session transcript by session ID, including project, issue, workspace, session metadata, and ordered messages. |
| `get_session_stats` | Get token usage, cost, and duration stats for a session |
| `search_sessions` | Search agent session transcripts globally or within a project/issue. Use this to answer questions like how ticket ak287 was implemented and what problems the agent hit. |
| `analyze_session` | Show a consolidated analysis of a session: workspace, issue, parsed summary with tool patterns, stats, and errors. Mirrors `pnpm cli -- session analyze <session-id>`. |
| `get_fleet_friction` | Aggregate agent-session friction (failed tool calls, repeated commands, error counts) across all sessions in a recent time window. Use to find systemic, compounding improvements (skills/hooks/helper scripts). Reads persisted friction stats; run `session backfill-friction` first if coverage is low. |
| `backfill_friction` | Populate friction stats (tool failures, repeated commands, errors) for past sessions from their stored messages, so friction analysis covers history. Idempotent — skips sessions that already have friction data unless force=true. Mirrors `pnpm cli -- session backfill-friction`. |
| `session_history` | Inspect Claude Code session transcript files from ~/.claude/projects/ for worktrees linked to kanban issues. Shows what the agent did and why it stopped, without loading entire large files. Mirrors CLI `session-history [issue-number]`. |
| `list_tags` | List all available tags (labels) for categorizing issues |
| `create_tag` | Create a new tag (label) for categorizing issues |
| `review_workspace` | Trigger an AI code review for an idle workspace. The workspace must be in 'idle' status. |
| `get_diff_comments` | Get diff review comments for a workspace, optionally filtered by file path |
| `create_diff_comment` | Add a review comment on a file in a workspace's diff |
| `approve_tool_use` | Internal tool used by Claude Code's --permission-prompt-tool flag. Routes tool approval requests to the agentic-kanban UI for user approval. Returns allow/deny/allow_session/deny_session. |
| `session_review_effectiveness` | Measure how the ticket-implementation workflow interacts with AI code review. Reconstructs each ticket's build->review->merge lifecycle from sessions + workspaces + diff comments. Code-review agent runs are identified by triggerType 'review' or 'skill:code-review*'. Mirrors `pnpm cli -- session review-effectiveness`. |
| `reviewer_fixes` | Measure how often the code-review agent FIXES findings itself (and commits) vs only approving. Two methods: git (commit author-time inside a review session's window) and deep transcript analysis (--deep). Mirrors `pnpm cli -- session reviewer-fixes`. |
| `add_dependency` | Add a dependency link between two issues. Types: depends_on (prerequisite), blocked_by (inverse of depends_on), related_to (symmetric link), duplicates (marks as duplicate), parent_of (parent-child), child_of (inverse of parent_of), coupled_with (symmetric peer edge: two issues touch the same code and are best implemented together). Rejects cycles for directional types and self-dependencies. |
| `remove_dependency` | Remove a dependency link between two issues |
| `analyze_dependencies` | Analyze one issue against the current board and create inferred dependency edges. Use after creating related child issues so independent tasks remain unblocked and dependent tasks stay blocked. |
| `update_dependencies_batch` | Add or remove multiple dependency edges atomically. Idempotent: existing add or missing remove is skipped (not failed). Cycle detection across the batch; rolls back on cycle. |
| `contract_coupled_issues` | Contract a full coupled_with connected component onto one lead issue. The selected issueIds must exactly match the component; external sequential dependencies are inherited by the lead and internal coupled_with edges are removed. |
| `propose_transition` | Advance the current issue's workflow to the next stage. Call this when the work for the current stage is done. Pass the workspaceId from your workflow instructions (or the issueId), the target stage name (toNodeName), and a short summary of what you completed. |
| `clarify_or_propose` | For workflow phase skills: either raise a structured clarifying question in the interactive UI, or propose the next workflow gate. |
| `list_workflow_templates` | List workflow templates available to a project (project-scoped + global built-ins). Returns id, name, ticketType, isBuiltin, and stage/edge counts. |
| `get_workflow_template` | Get a workflow template's full graph (nodes + edges) by id. |
| `create_workflow_template` | Create a project workflow template (graph of stages + transitions). Each node maps to a board status and may attach a skill by name. Exactly one 'start', at least one 'end', no orphan nodes; a 'parallel-fork' needs a matching 'parallel-join'. Edges support conditions (manual/auto_on_exit_0/tests_pass/tests_fail/diff_clean/diff_touches). Use node-type 'parallel-fork' to run branches concurrently (e.g. parallel research) and 'parallel-join' to consolidate. |
| `update_workflow_template` | Update a non-built-in workflow template. Pass nodes+edges together to replace the graph (validated). Built-in templates cannot be edited — duplicate via create_workflow_template first. |
| `delete_workflow_template` | Delete a non-built-in workflow template (cascades its nodes + edges). |
| `list_agent_skills` | List all available agent skills that can be applied to workspaces |
| `get_agent_skill` | Get full details of an agent skill including its prompt |
| `create_agent_skill` | Create a new agent skill with a name, description, and prompt template |
| `export_agent_skills` | Export agent skills as SKILL.md files for Claude Code and Codex. Writes .claude/skills and links .codex/skills to the same directory. |
| `install_skill` | Install built-in agent skills as SKILL.md files into a project's .claude/skills/ directory and link .codex/skills to the same location. Mirrors CLI `install-skill [target-path]`. Reads built-in global skills from the DB (requires db:seed to have run). Each skill is written as <targetPath>/.claude/skills/<name>/SKILL.md. |
| `openspec_list_specs` | List the living OpenSpec domains for a project. Use this before answering project architecture or behavior questions from specs. |
| `show_spec` | Show a living OpenSpec domain spec for a project. Butler answers about how the project works should cite this content when applicable. |
| `validate_change` | Validate OpenSpec change deltas under openspec/changes. Checks ADDED/MODIFIED/REMOVED sections and warns about same-domain delta collisions. |
| `start_drive` | Start a Drive: a first-class record of an autonomous epic push toward a target under a completion contract. Creates a Drive record (status='active') that survives a server restart and is queryable via list_drives/get_drive. |
| `list_drives` | List all Drives for a project (most recently started first). A Drive records an autonomous epic push: its target, completion contract, status (active/completed/abandoned), and start/finish times. |
| `get_drive` | Get a single Drive by ID, including its target, completion contract, status, and start/finish timestamps. |
| `finish_drive` | Finish a Drive: set a terminal status ('completed' or 'abandoned') and stamp finishedAt. Use when the epic is fully merged (completed) or the drive is given up (abandoned). |
| `drive_review_effectiveness` | Get AI code-review effectiveness metrics for a Drive: reviews run, reviews that bounced a ticket back to building, and tickets merged without any review. Scoped to the drive's time window and — when the drive has a meta-issue — to that meta-issue's dependency subtree (pass wholeProject=true to ignore the subtree restriction). Mirrors CLI `drive review-effectiveness <drive-id>`. |
| `register_project` | Register an existing git repository as a project on the kanban board. Auto-detects repo name, default branch, and remote URL. Creates the default statuses (Backlog, Todo, In Progress, In Review, AI Reviewed, Done, Cancelled) and sets the project as active. If the repo is already registered, returns the existing project. |
| `create_project` | Create a new directory, initialize it as a git repository, and register it as a project on the kanban board. Use register_project instead if the repo already exists. The directory is created inside the configured projects_base_path preference unless an explicit path is provided. |
| `list_projects` | List all registered projects on the kanban board. Shows project name, ID, repo path, default branch, and remote URL. The currently active project is indicated in the result. |
| `unregister_project` | Remove a project registration from the kanban board by name or project ID. Cascade-deletes all associated data: issues, workspaces, sessions, issue tags, and project statuses. This is irreversible — use with care. |
| `cleanup_project` | Report stale git worktrees for closed/merged workspaces in a project. Lists workspace branches and their worktree paths so they can be removed manually with 'git worktree remove --force <path>'. This tool does NOT auto-remove worktrees — it only reports them. Omit projectId to scan all projects. |
| `init_project` | Initialize and register a git repository as a project on the kanban board. Mirrors CLI `init [path]`. The server must already be running (the MCP server itself being active satisfies this). If no path is provided, only confirms the server is reachable and migrations are up to date. |
| `list_project_repos` | List the ADDITIONAL (sibling) repos attached to a multi-repo project. Returns an array of repo rows ({ id, path, name, defaultBranch, setupScript, composeFile }). Does NOT include the leading repo (that is the project's own repoPath, from list_projects). An empty array means the project is single-repo. |
| `add_project_repo` | Attach an ADDITIONAL git repository to an existing multi-repo project (the 'full-peers' model). The project's registered repo is the LEADING repo (the agent starts there); every repo added here becomes a sibling that each new workspace also gets a worktree for on the same branch, with merge landing every repo that has commits. To build a multi-repo project: first `register_project` the leading repo, then call this once per sibling with that project's id. Provide exactly one of `path` (absolute path to an existing local repo), `cloneUrl` (clone a remote), or `createName` (scaffold a brand-new git repo in a new folder created inside the project folder, beside the leading repo). |
| `remove_project_repo` | Detach an ADDITIONAL (sibling) repo from a multi-repo project. Removes only the project↔repo association — the checkout on disk is left untouched and existing workspaces keep their worktrees. Use `list_project_repos` to find the repoId. Cannot remove the leading repo (that is unregister_project territory). |
| `get_preference` | Get a preference value by key. Mirrors CLI `preferences get <key>`. Returns the stored value string, or a message indicating it is not set. |
| `set_preference` | Set (upsert) a preference value by key. Mirrors CLI `preferences set <key> <value>`. Validates like the settings route: unknown keys are rejected (allowed: static settings-registry keys, harness.<harness>.plan_auto_continue, per-project dynamic keys like start_mode_<projectId>, and board_strategy_<projectId>), and start_mode_* values must be exactly manual|monitor|conductor. Use get_preference to read it back. |
| `ask_butler` | Ask the project butler — a warm, persistent Claude assistant running in the project's repo — a question and get its answer back. Use for quick questions about the project, codebase, or board without spawning a new workspace. Maintains conversation context across calls. |
| `butler_ensure` | Start (warm) the butler session for a project if it is not already running. Equivalent to CLI `butler ensure`. Safe to call repeatedly — no-ops when the butler is already warm. |
| `butler_stop` | Stop the butler's warm session and forget its resume id. The butler can be restarted later via butler_ensure. Equivalent to CLI `butler stop`. |
| `butler_list` | List all defined butlers and their per-project runtime state (warm/stopped, session id). Equivalent to CLI `butler list`. |
| `butler_interrupt` | Interrupt the butler's in-flight turn. The warm session is preserved (context is kept); only the current response generation is cancelled. |
| `butler_state` | Get the butler's current state for a project: whether the warm session is active, current model/profile selection, context-window usage, and MCP connection status. |
| `butler_set_model` | Switch the butler's model live (no session restart, context preserved). Pass an empty model string to revert to the profile/CLI default. |
| `butler_set_profile` | Switch the butler's Claude profile. This restarts the warm session (different auth/endpoint cannot resume). Pass an empty profile to revert to the global default. |
| `get_butler_skill` | Get the butler's editable system prompt (skill) for a project. Returns the prompt text and whether it is a project-scoped override or the global default. Equivalent to CLI `butler skill get`. |
| `set_butler_skill` | Set (upsert) the butler's system prompt (skill) for a project, creating a project-scoped override. Pass an empty string to reset to the global default. Equivalent to CLI `butler skill set <prompt>`. |

### Common tool workflows

**Plan and execute:** `list_issues` > `get_issue` > `start_workspace` > `launch_workspace` > `wait_workspace` > `merge_workspace`

**Review flow:** `list_workspaces` > `get_workspace_diff` > `review_workspace` > `get_diff_comments` > `merge_workspace`

**Board maintenance:** `get_board_status` > `analyze_dependencies` > `update_issue`

## Monitoring & Automation

agentic Kanban can run autonomously with the Monitor, driving the issue-to-merge loop without manual intervention.

### Start Modes

Each project has a Start Mode (Settings > Workflow > Board Monitor):

| Mode | Behavior |
|------|----------|
| **manual** | Nothing auto-starts. You launch workspaces explicitly. |
| **monitor** | In-process engine auto-starts unblocked backlog up to WIP limit. |
| **conductor** | Out-of-process loop drives the project. The in-process engine stands down. |

### Monitor cycle

When the monitor is active, it runs periodically (configurable interval in Settings):

1. Checks for unblocked backlog issues
2. Launches workspaces up to the WIP limit
3. Reviews idle workspaces
4. Merges ready-to-merge workspaces
5. Nudges stale workspaces

### Scheduled runs

Configure recurring agent tasks in **Settings > Schedule**:

- **Name** — e.g. "Daily standup update"
- **Prompt** — what the agent should do
- **Interval** — how often (in minutes)

### Board health

The board stats bar shows:

- Ticket counts per status
- Circular progress ring (total + % done)
- Active profile badge
- Blocked filter toggle
- Commits on main counter

## Desktop App

agentic Kanban ships as a Tauri v2 desktop app for native performance.

### Install

Requires Rust + MSVC C++ Build Tools ("Desktop development with C++" workload in Visual Studio Installer).

```bash
pnpm dev:desktop
```

### Features

- **System tray** — stays running in the background
- **OS notifications** — workspace merged, session completed
- **Native window** — not just a browser tab
- **Auto-update** — update to latest version from the tray menu

## Troubleshooting

### Server won't start

**Port already in use:**
```powershell
$proc = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($proc) { Stop-Process -Id $proc -Force }
```

### `spawn pnpm ENOENT`

pnpm is missing from PATH. Run:
```bash
corepack enable && corepack prepare pnpm@10.12.1 --activate
```

### `EBUSY: resource busy or locked`

The database is held open by a running server. Stop the server first, then retry.

### `SQLITE_ERROR: no such column`

A migration was not applied. Run:
```bash
pnpm db:migrate
```

### Client: `Failed to resolve entry for "@agentic-kanban/shared"`

Run:
```bash
pnpm --filter @agentic-kanban/shared build
```

### Backend hangs (proxy up, nothing on :3001)

`tsx watch` + Node 23.x hangs on Windows. Use Node LTS 22.

### DB looks empty / wrong project

The server fell back to `~/.agentic-kanban/kanban.db`. Check that `packages/server/kanban.db` exists after `pnpm db:setup`.

### Agent won't start / stale workspace

A workspace showing ~1 second with zero tokens is likely a launch failure:

1. Stop the workspace
2. Create a fresh workspace for the same issue
3. If the issue persists, check the agent CLI is installed (`claude --version`)

### Need more help?

- Open the Butler (`i`) and ask about your issue
- Check the Runbooks view (`j`) for project-specific docs
- File an issue on [GitHub](https://github.com/p-wegner/agentic-kanban/issues)