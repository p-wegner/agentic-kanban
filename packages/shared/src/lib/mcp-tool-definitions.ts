export type McpToolCategory =
  | "board"
  | "issues"
  | "workspaces"
  | "sessions"
  | "tags"
  | "review"
  | "dependencies"
  | "skills";

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
  { id: "skills", label: "Agent Skills" },
];

export const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  // board
  { name: "get_context", description: "Get current project context including project info, issues count by status, and active workspaces", category: "board" },
  { name: "get_board_status", description: "Get a comprehensive overview of all active/in-progress items on the board", category: "board" },
  // issues
  { name: "list_issues", description: "List all issues for a project, optionally filtered by status name, priority, tag, or blocked status", category: "issues" },
  { name: "get_issue", description: "Get detailed information about a specific issue, including workspaces and dependencies", category: "issues" },
  { name: "create_issue", description: "Create a new issue on the kanban board", category: "issues" },
  { name: "update_issue", description: "Update an existing issue (title, description, status, priority)", category: "issues" },
  { name: "delete_issue", description: "Delete an issue and all its associated data (workspaces, sessions, messages, tags)", category: "issues" },
  { name: "move_issue", description: "Move an issue to a different status column by name (e.g., 'Todo', 'In Progress', 'Done')", category: "issues" },
  // workspaces
  { name: "list_workspaces", description: "List workspaces, optionally filtered by issue ID", category: "workspaces" },
  { name: "start_workspace", description: "Create a workspace for an issue: creates a git worktree and returns workspace info", category: "workspaces" },
  { name: "get_workspace_diff", description: "Get the git diff for a workspace's working directory", category: "workspaces" },
  { name: "merge_workspace", description: "Merge a workspace branch into the project's default branch, close the workspace, and auto-transition the issue", category: "workspaces" },
  { name: "close_workspace", description: "Close a workspace without merging. For direct workspaces or abandoned work.", category: "workspaces" },
  { name: "stop_workspace", description: "Stop any running agent session for a workspace", category: "workspaces" },
  { name: "delete_workspace", description: "Delete a workspace and all its sessions, messages, and diff comments", category: "workspaces" },
  // sessions
  { name: "list_sessions", description: "List all sessions for a workspace, including status and timing", category: "sessions" },
  { name: "read_terminal", description: "Read agent session output (terminal messages) for a session", category: "sessions" },
  { name: "get_session_stats", description: "Get token usage, cost, and duration stats for a session", category: "sessions" },
  // tags
  { name: "list_tags", description: "List all available tags (labels) for categorizing issues", category: "tags" },
  { name: "create_tag", description: "Create a new tag (label) for categorizing issues", category: "tags" },
  // review
  { name: "get_diff_comments", description: "Get diff review comments for a workspace, optionally filtered by file path", category: "review" },
  { name: "create_diff_comment", description: "Add a review comment on a file in a workspace's diff", category: "review" },
  // dependencies
  { name: "add_dependency", description: "Add a dependency link between two issues", category: "dependencies" },
  { name: "remove_dependency", description: "Remove a dependency link between two issues", category: "dependencies" },
  // skills
  { name: "list_agent_skills", description: "List all available agent skills that can be applied to workspaces", category: "skills" },
  { name: "get_agent_skill", description: "Get full details of an agent skill including its prompt", category: "skills" },
  { name: "create_agent_skill", description: "Create a new agent skill with a name, description, and prompt template", category: "skills" },
  { name: "export_agent_skills", description: "Export agent skills as SKILL.md files for Claude Code and Codex", category: "skills" },
];
