export type McpToolCategory =
  | "board"
  | "issues"
  | "workspaces"
  | "sessions"
  | "tags"
  | "review"
  | "dependencies"
  | "workflow"
  | "skills"
  | "specs"
  | "drives"
  | "projects"
  | "settings"
  | "butler";

export interface McpToolDefinition {
  name: string;
  description: string;
  category: McpToolCategory;
}

export const MCP_TOOL_CATEGORIES: { id: McpToolCategory; label: string }[] = [
  { id: "board", label: "Board Overview" },
  { id: "issues", label: "Issues" },
  { id: "workspaces", label: "Workspaces" },
  { id: "sessions", label: "Sessions" },
  { id: "tags", label: "Tags" },
  { id: "review", label: "Code Review" },
  { id: "dependencies", label: "Dependencies" },
  { id: "workflow", label: "Workflow" },
  { id: "skills", label: "Agent Skills" },
  { id: "specs", label: "Living Specs" },
  { id: "drives", label: "Drives" },
  { id: "projects", label: "Projects" },
  { id: "settings", label: "Settings" },
  { id: "butler", label: "Butler" },
];

export const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  // board
  { name: "get_context", description: "Get current project context including project info, issues count by status, and active workspaces", category: "board" },
  { name: "get_board_status", description: "Get a comprehensive overview of all active/in-progress items on the board", category: "board" },
  { name: "get_board_risk_digest", description: "Get a risk digest of the current board state: merge pile-ups, stale workspaces, launch failures, and other hazards", category: "board" },
  { name: "find_similar_failures", description: "Find past failures similar to an issue's error signature, to reuse prior fixes", category: "board" },
  { name: "delete_status", description: "Delete a status column from a project's workflow", category: "board" },
  // issues
  { name: "list_issues", description: "List all issues for a project, optionally filtered by status name, priority, tag, or blocked status", category: "issues" },
  { name: "get_issue", description: "Get detailed information about a specific issue, including workspaces and dependencies", category: "issues" },
  { name: "get_issue_summary", description: "Get a concise summary of an issue's state, workspaces, and recent activity", category: "issues" },
  { name: "create_issue", description: "Create a new issue on the kanban board", category: "issues" },
  { name: "create_sub_issue", description: "Create a child issue linked to a parent issue with a parent/child dependency", category: "issues" },
  { name: "create_issues_batch", description: "Create multiple issues at once, optionally with dependency edges between them", category: "issues" },
  { name: "update_issue", description: "Update an existing issue (title, description, status, priority)", category: "issues" },
  { name: "delete_issue", description: "Delete an issue and all its associated data (workspaces, sessions, messages, tags)", category: "issues" },
  { name: "move_issue", description: "Move an issue to a different status column by name (e.g., 'Todo', 'In Progress', 'Done')", category: "issues" },
  { name: "attach_artifact", description: "Attach a text, link, image, or video artifact to an issue", category: "issues" },
  { name: "check_issue_overlap", description: "Check whether issues touch overlapping files, to detect merge-conflict risk before parallel work", category: "issues" },
  { name: "analyze_touched_files", description: "Predict which source files an issue will likely modify", category: "issues" },
  // workspaces
  { name: "list_workspaces", description: "List workspaces, optionally filtered by issue ID", category: "workspaces" },
  { name: "start_workspace", description: "Create a workspace for an issue: creates a git worktree and returns workspace info", category: "workspaces" },
  { name: "launch_workspace", description: "Launch (or relaunch) an idle workspace's agent session, auto-building the prompt from the issue when omitted", category: "workspaces" },
  { name: "relaunch_workspace", description: "Relaunch the agent for an existing workspace, resuming its session where supported", category: "workspaces" },
  { name: "wait_workspace", description: "Wait (bounded poll) until a workspace reaches a terminal status (idle, ready_for_merge, closed, merged) or the timeout elapses", category: "workspaces" },
  { name: "get_workspace_diff", description: "Get the git diff for a workspace's working directory", category: "workspaces" },
  { name: "get_workspace_scorecard", description: "Get the PR quality scorecard for a workspace (0-100 with per-dimension breakdown)", category: "workspaces" },
  { name: "merge_workspace", description: "Merge a workspace branch into the project's default branch, close the workspace, and auto-transition the issue", category: "workspaces" },
  { name: "close_workspace", description: "Close a workspace without merging. For direct workspaces or abandoned work.", category: "workspaces" },
  { name: "mark_ready_for_merge", description: "Mark a workspace as reviewed and ready to merge. Call after a successful code review with no critical/major issues.", category: "workspaces" },
  { name: "stop_workspace", description: "Stop any running agent session for a workspace", category: "workspaces" },
  { name: "delete_workspace", description: "Delete a workspace and all its sessions, messages, and diff comments", category: "workspaces" },
  { name: "export_handoff_bundle", description: "Export a compact handoff bundle (metadata, diff stats, agent summary, changed files, errors) for a workspace", category: "workspaces" },
  // sessions
  { name: "list_sessions", description: "List all sessions for a workspace, including status and timing", category: "sessions" },
  { name: "recent_sessions", description: "List the most recent agent sessions across the board with their issue and status", category: "sessions" },
  { name: "read_terminal", description: "Read agent session output (terminal messages) for a session", category: "sessions" },
  { name: "get_session_transcript", description: "Get the full transcript (messages and tool calls) for a session", category: "sessions" },
  { name: "get_session_stats", description: "Get token usage, cost, and duration stats for a session", category: "sessions" },
  { name: "search_sessions", description: "Search session messages by text across the board", category: "sessions" },
  { name: "analyze_session", description: "Analyze a single session: files read/edited, commands, errors, and a structured summary", category: "sessions" },
  { name: "get_fleet_friction", description: "Aggregate fleet-level friction signals (errors, retries, stalls) across sessions in a time window", category: "sessions" },
  { name: "backfill_friction", description: "Recompute and persist friction stats for ended sessions that are missing them", category: "sessions" },
  { name: "session_history", description: "List session history, optionally filtered by issue number", category: "sessions" },
  // tags
  { name: "list_tags", description: "List all available tags (labels) for categorizing issues", category: "tags" },
  { name: "create_tag", description: "Create a new tag (label) for categorizing issues", category: "tags" },
  // review
  { name: "review_workspace", description: "Trigger an AI code review for an idle workspace", category: "review" },
  { name: "get_diff_comments", description: "Get diff review comments for a workspace, optionally filtered by file path", category: "review" },
  { name: "create_diff_comment", description: "Add a review comment on a file in a workspace's diff", category: "review" },
  { name: "approve_tool_use", description: "Approve a pending agent tool-use request that is awaiting human approval", category: "review" },
  { name: "session_review_effectiveness", description: "Reconstruct the build→review→merge lifecycle and report review coverage and effectiveness", category: "review" },
  { name: "reviewer_fixes", description: "Report the fixes a reviewer applied versus the changes that bounced back", category: "review" },
  // dependencies
  { name: "add_dependency", description: "Add a dependency link between two issues", category: "dependencies" },
  { name: "remove_dependency", description: "Remove a dependency link between two issues", category: "dependencies" },
  { name: "analyze_dependencies", description: "Analyze an issue's relationships to other open issues and suggest dependency edges", category: "dependencies" },
  { name: "update_dependencies_batch", description: "Apply a batch of dependency add/remove operations atomically with cycle detection", category: "dependencies" },
  // workflow
  { name: "propose_transition", description: "Advance the current issue's workflow to the next stage when the current stage's work is done", category: "workflow" },
  { name: "clarify_or_propose", description: "For workflow phase skills: raise a structured clarifying question, or propose the next workflow gate", category: "workflow" },
  { name: "list_workflow_templates", description: "List configurable workflow templates (graphs of stages and transitions)", category: "workflow" },
  { name: "get_workflow_template", description: "Get a single workflow template by ID, including its nodes and edges", category: "workflow" },
  { name: "create_workflow_template", description: "Create a new workflow template from a graph of stages and transitions", category: "workflow" },
  { name: "update_workflow_template", description: "Update an existing workflow template's nodes, edges, or metadata", category: "workflow" },
  { name: "delete_workflow_template", description: "Delete a workflow template", category: "workflow" },
  // skills
  { name: "list_agent_skills", description: "List all available agent skills that can be applied to workspaces", category: "skills" },
  { name: "get_agent_skill", description: "Get full details of an agent skill including its prompt", category: "skills" },
  { name: "create_agent_skill", description: "Create a new agent skill with a name, description, and prompt template", category: "skills" },
  { name: "export_agent_skills", description: "Export agent skills as SKILL.md files for Claude Code and Codex", category: "skills" },
  { name: "install_skill", description: "Write the built-in agent skills as SKILL.md files into a target directory", category: "skills" },
  // specs
  { name: "openspec_list_specs", description: "List living OpenSpec domain specs for a project", category: "specs" },
  { name: "show_spec", description: "Show a living OpenSpec domain spec for a project", category: "specs" },
  { name: "validate_change", description: "Validate OpenSpec change deltas and warn about same-domain collisions", category: "specs" },
  // drives
  { name: "start_drive", description: "Start a Drive: a first-class record of an autonomous epic push toward a target under a completion contract", category: "drives" },
  { name: "list_drives", description: "List all Drives for a project (target, completion contract, status, start/finish times)", category: "drives" },
  { name: "get_drive", description: "Get a single Drive by ID", category: "drives" },
  { name: "finish_drive", description: "Finish a Drive: set a terminal status (completed/abandoned) and stamp finishedAt", category: "drives" },
  { name: "drive_review_effectiveness", description: "Report review effectiveness scoped to a Drive's window and meta-issue dependency subtree", category: "drives" },
  // projects
  { name: "register_project", description: "Register an existing git repository as a project on the board", category: "projects" },
  { name: "create_project", description: "Create a new git repository and register it as a project", category: "projects" },
  { name: "list_projects", description: "List all registered projects and indicate the active one", category: "projects" },
  { name: "unregister_project", description: "Remove a project registration (does not delete the repository)", category: "projects" },
  { name: "cleanup_project", description: "Clean up stale worktrees for closed workspaces in a project", category: "projects" },
  { name: "init_project", description: "Initialize board setup (migrate/seed) and optionally register the current repository", category: "projects" },
  // settings
  { name: "get_preference", description: "Read a board preference value by key", category: "settings" },
  { name: "set_preference", description: "Write a board preference value by key", category: "settings" },
  // butler
  { name: "ask_butler", description: "Ask the project's warm Butler assistant a question and get a synchronous answer", category: "butler" },
  { name: "butler_ensure", description: "Start or warm the project's Butler session", category: "butler" },
  { name: "butler_stop", description: "Stop the project's Butler session and forget its resume state", category: "butler" },
  { name: "butler_list", description: "List the project's Butler definitions and their runtime state", category: "butler" },
  { name: "butler_interrupt", description: "Interrupt the Butler's in-flight turn while keeping the session warm", category: "butler" },
  { name: "butler_state", description: "Get the Butler's current state (model, profile, context usage)", category: "butler" },
  { name: "butler_set_model", description: "Set the Butler's model (applied live without restarting the session)", category: "butler" },
  { name: "butler_set_profile", description: "Set the Butler's Claude profile (restarts the session)", category: "butler" },
  { name: "get_butler_skill", description: "Get the Butler's custom skill prompt", category: "butler" },
  { name: "set_butler_skill", description: "Set the Butler's custom skill prompt", category: "butler" },
];
