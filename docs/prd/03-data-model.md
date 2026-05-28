# PRD-03: Data Model

Core data entities and relationships for the implementation. The actual schema uses 13 tables managed via Drizzle ORM with 20 migrations.

## Entity-Relationship Overview

```
Project 1──* ProjectStatus
Project 1──* Issue
Project 1──* Workspace (via Issue)
Issue   *──* Tag (via issue_tags)
Issue   1──* IssueRelationship (typed dependencies)
Issue   1──* Workspace
Workspace 1──* Session
Workspace 1──* DiffComment
Session  1──* SessionMessage
AgentSkill *──* Workspace (via skill_id, project_id)
Preference (singleton key/value)
```

## Core Entities

### Project
The top-level container. Each project maps 1:1 to a registered git repo.
```
Project {
  id: UUID (PK)
  name: String               // Directory basename
  description: String?

  // Git integration (auto-detected at registration)
  repoPath: String           // Absolute path to git repo
  repoName: String           // Directory basename
  defaultBranch: String?     // e.g. "main", "master"
  remoteUrl: String?         // git remote get-url origin

  // Setup scripts
  setupScript: String?       // Shell commands to run after worktree creation
  setupBlocking: Boolean     // true = wait for setup before agent

  createdAt: DateTime
  updatedAt: DateTime
}
```

### ProjectStatus (Kanban Column)
Configurable columns for each project's kanban board.
```
ProjectStatus {
  id: UUID (PK)
  projectId: UUID (FK → Project)
  name: String               // "Todo", "In Progress", etc.
  sortOrder: Int             // Column position
  isDefault: Boolean         // New issues land here
  createdAt: DateTime
}
```
**Default statuses**: Todo, In Progress, In Review, Done, Cancelled

### Issue (Kanban Card)
The central entity — a task to be planned, executed, and reviewed.
```
Issue {
  id: UUID (PK)
  projectId: UUID (FK → Project)
  statusId: UUID (FK → ProjectStatus)

  issueNumber: Int           // Auto-incrementing per project (#1, #2, #3)
  title: String
  description: String?       // Markdown

  priority: IssuePriority    // urgent, high, medium, low
  sortOrder: Int             // Position within column

  skipAutoReview: Boolean    // Skip AI code review on agent exit

  createdAt: DateTime
  updatedAt: DateTime
}

enum IssuePriority {
  urgent
  high
  medium
  low
}
```

### Tag
Labels for categorizing issues. Available to all projects.
```
Tag {
  id: UUID (PK)
  name: String               // Unique name
  color: String?             // Hex color code
  createdAt: DateTime
}

// Many-to-many junction
IssueTag {
  id: UUID (PK)
  issueId: UUID (FK → Issue)
  tagId: UUID (FK → Tag)
}
```

### IssueRelationship
Typed links between issues with 6 dependency types.
```
IssueRelationship {
  id: UUID (PK)
  issueId: UUID (FK → Issue)         // Source issue
  dependsOnId: UUID (FK → Issue)     // Target issue
  type: RelationshipType             // depends_on, blocked_by, related_to,
}                                    //   duplicates, parent_of, child_of

// Cycle detection enforced on add
// Unique index on (issueId, dependsOnId)
```

## Workspace & Execution Entities

### Workspace
An isolated execution environment linked to an issue. Created in one step: DB record + git worktree + auto-launch agent.
```
Workspace {
  id: UUID (PK)
  issueId: UUID (FK → Issue)

  branch: String?            // Git branch name (null for direct)
  workingDir: String?        // Absolute path (null for merged/closed)
  baseBranch: String?        // Branch worktree was created from

  status: WorkspaceStatus    // active, idle, closed
  isDirect: Boolean          // true = work on main checkout, no worktree

  planMode: Boolean          // Agent runs in plan mode (read-only)
  skillId: UUID? (FK → AgentSkill)
  claudeProfile: String?     // Profile name for gateway auth

  closedAt: DateTime?

  createdAt: DateTime
  updatedAt: DateTime
}

enum WorkspaceStatus {
  active    // Agent is running
  idle      // Agent finished, awaiting review/merge
  closed    // Merged or closed
}
```

### Session
A single agent execution session within a workspace. Multiple sessions per workspace via `--resume` chains.
```
Session {
  id: UUID (PK)
  workspaceId: UUID (FK → Workspace)

  status: SessionStatus      // starting, running, stopped

  // Claude session tracking
  claudeSessionId: String?   // Claude's internal session ID (from system/init)
  resumeFromId: UUID? (FK → Session)  // Previous session in resume chain

  startedAt: DateTime
  endedAt: DateTime?
  exitCode: Int?

  // Stats (extracted from stream-json)
  modelName: String?
  totalTokens: Int?
  totalCost: Decimal?
  durationMs: Int?
}

enum SessionStatus {
  starting
  running
  stopped
}
```

### SessionMessage
Persisted agent output for replay and history.
```
SessionMessage {
  id: UUID (PK)
  sessionId: UUID (FK → Session)
  type: String               // "output", "exit", etc.
  data: String               // JSON-encoded message content
  exitCode: Int?
  createdAt: DateTime
}
```

### DiffComment
Inline comments on workspace diffs.
```
DiffComment {
  id: UUID (PK)
  workspaceId: UUID (FK → Workspace)
  filePath: String           // File path in diff
  lineNumOld: Int?           // Line number on old (base) side
  lineNumNew: Int?           // Line number on new (changed) side
  side: String               // "old" or "new"
  body: String               // Comment text
  createdAt: DateTime
  updatedAt: DateTime
}
```

## Agent Skill Entity

### AgentSkill
Prompt templates injected into agent context at workspace creation. Written as SKILL.md files in worktree for agent discovery.
```
AgentSkill {
  id: UUID (PK)
  name: String               // Unique per scope (global or same projectId)
  description: String
  prompt: String             // Full prompt template with {{placeholders}}
  model: String?             // Optional model override (e.g., "haiku")

  projectId: UUID? (FK → Project)  // null = global, set = project-scoped
  isBuiltin: Boolean         // true = seeded, not editable/deletable

  createdAt: DateTime
  updatedAt: DateTime
}
```

**Built-in skills** (seeded on `pnpm db:seed`):
- `board-navigator` — comprehensive board interaction guide
- `code-review` — default AI code review prompt (customizable per project)
- `dependency-analyzer` — analyze issue dependencies (haiku model)
- `ticket-enhancer` — improve ticket clarity (haiku model)

## Settings Entity

### Preference
Generic key/value store for application settings.
```
Preference {
  key: String (PK)           // e.g., "activeProjectId", "agent_command"
  value: String              // JSON-encoded value
}
```

**Known keys**: `activeProjectId`, `agent_command`, `agent_args`, `output_parser`, `mock_agent`, `auto_merge`, `review_auto_fix`, `claude_profile`

**Per-project butler keys** (dynamic, suffixed with the projectId): `butler_session_<projectId>` (persisted SDK session id for warm resume), `butler_model_<projectId>` (model override; "" = profile/CLI default), `butler_profile_<projectId>` (Claude profile override; "" = inherit the global `claude_profile`).

## Schema Evolution

Migrations are managed via Drizzle Kit. SQL files in `packages/shared/drizzle/*.sql` with journal entries in `packages/shared/drizzle/meta/_journal.json`.

Key migrations:
- 0001: Initial schema (8 tables)
- 0002: Preferences table + project git columns
- 0003: Session messages table
- 0004: Claude session tracking (claudeSessionId, resumeFromId)
- 0006: Issue numbers (issue_number column)
- 0007: Diff comments table
- 0011: Workspace closed_at column
- 0013: Plan mode (planMode column on workspaces)
- 0018–0019: Agent skills tables
- 0020: Dependency types column + unique index

## What Was Excluded
These entities from the original analysis are not in our implementation:
- **Repo** — replaced by git info columns directly on Project
- **PullRequest** — manual merge only
- **Users / Organizations** — single-user app
- **Notifications** — handled via Tauri OS notifications + WebSocket
- **Attachments** — not planned
