# PRD-03: Data Model

Core data entities and relationships for the reimplementation.

## Entity-Relationship Overview

```
Project 1──* Issue
Project 1──* ProjectStatus (columns/lanes)
Project 1──* Tag
Project 1──* Repo
Issue   *──* Tag
Issue   1──* IssueRelationship
Issue   1──* Workspace
Issue   1──  IssuePriority
Workspace 1──* Session
Workspace 1──* Repo
Session 1──* ExecutionProcess
```

## Core Entities

### Project
The top-level container. In single-user mode, likely just one or a few projects.
```
Project {
  id: UUID
  name: String
  color: String?          // Brand color for UI
  description: String?
  created_at: DateTime
  updated_at: DateTime
}
```

### ProjectStatus (Kanban Column)
Configurable columns for each project's kanban board.
```
ProjectStatus {
  id: UUID
  project_id: UUID        // FK → Project
  name: String            // "To Do", "In Progress", etc.
  color: String?
  sort_order: Int         // Column position
  is_default: Boolean     // New issues land here
  created_at: DateTime
}
```
**Default statuses**: Todo, In Progress, In Review, Done, Cancelled

### Issue (Kanban Card)
The central entity - a task to be planned, executed, and reviewed.
```
Issue {
  id: UUID
  project_id: UUID        // FK → Project
  status_id: UUID         // FK → ProjectStatus

  title: String
  description: String?    // Markdown

  priority: IssuePriority  // Urgent, High, Medium, Low

  sort_order: Int         // Position within column

  parent_issue_id: UUID?  // For sub-issues

  created_at: DateTime
  updated_at: DateTime
}

enum IssuePriority {
  Urgent
  High
  Medium
  Low
}
```

### Tag
Labels for categorizing issues.
```
Tag {
  id: UUID
  project_id: UUID        // FK → Project
  name: String
  color: String?
}

// Many-to-many
IssueTag {
  issue_id: UUID
  tag_id: UUID
}
```

### IssueRelationship
Links between issues.
```
IssueRelationship {
  id: UUID
  source_issue_id: UUID
  target_issue_id: UUID
  type: RelationshipType   // Blocks, BlockedBy, Related, Duplicate
}
```

## Workspace & Execution Entities

### Workspace
An isolated execution environment linked to an issue.
```
Workspace {
  id: UUID
  issue_id: UUID?         // FK → Issue (optional)

  name: String?
  branch: String          // Git branch name
  working_dir: String     // Absolute path to working directory

  status: WorkspaceStatus
  archived: Boolean
  pinned: Boolean

  created_at: DateTime
  updated_at: DateTime
}

enum WorkspaceStatus {
  Created       // Just created, not started
  Running       // Agent is executing
  Stopped       // Agent finished or was stopped
  Error         // Agent crashed
}
```

### Repo
Git repository linked to a workspace (or project).
```
Repo {
  id: UUID
  workspace_id: UUID?     // FK → Workspace
  project_id: UUID?       // FK → Project

  path: String            // Absolute path to repo
  name: String            // Display name
  remote_url: String?     // Origin URL

  setup_script: String?   // Run after clone
  cleanup_script: String? // Run before cleanup
}
```

### Session
A single agent execution session within a workspace.
```
Session {
  id: UUID
  workspace_id: UUID      // FK → Workspace

  executor: ExecutorType   // Which agent
  status: SessionStatus

  started_at: DateTime
  stopped_at: DateTime?

  exit_code: Int?
}

enum ExecutorType {
  ClaudeCode    // Only one we support initially
}

enum SessionStatus {
  Starting
  Running
  Stopped
  Error
}
```

## Minimal Schema for MVP

For the first iteration, we need:
1. **Project** (1 default project)
2. **ProjectStatus** (5 default columns)
3. **Issue** (with status, priority, sort order)
4. **Tag** + **IssueTag**
5. **Workspace** (linked to issue)
6. **Repo** (linked to workspace)
7. **Session** (execution tracking)

**Explicitly excluded from MVP**:
- IssueRelationship (sub-issues, blocking)
- Attachments
- PullRequest
- Users / Organizations
- Notifications
