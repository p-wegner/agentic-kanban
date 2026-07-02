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
  { name: "get_board_status", description: "Get a comprehensive overview of all active/in-progress items on the board. Shows per-issue: workspace state, session status, diff stats, token/cost usage, and last agent output. This is the single best query to answer 'what are my agents doing right now?'", category: "board" },
  { name: "get_board_risk_digest", description: "Get a risk digest of the current board state. Summarizes merge blockers (conflicts or idle In-Review), stale sessions (error or running with no activity for 2+ hours), low backlog risk, and board health issues needing attention. Returns counts and the top 3 actionable items with issue numbers and short reasons. Use this when a user asks about board risks, blockers, or health.", category: "board" },
  { name: "find_similar_failures", description: "Search the failure-pattern memory for past incidents similar to a given error text. Returns top matches with root-cause and fix information. Use this when an agent session fails or encounters errors to find known solutions.", category: "board" },
  { name: "delete_status", description: "Delete a project status. Fails if any issues are linked to it.", category: "board" },
  // issues
  { name: "list_issues", description: "List all issues for a project, optionally filtered by status name, priority, tag, blocked status, or issue number", category: "issues" },
  { name: "get_issue", description: "Get detailed information about a specific issue, including workspaces and dependencies. Accepts either a UUID issue ID or a numeric issue number (e.g. 42). When resolving by number, pass projectId to scope to the correct project.", category: "issues" },
  { name: "get_issue_summary", description: "Get a summary of the latest completed agent session for an issue. Resolves issue number → workspace → latest session → parsed summary in one call. Shows agent summary text, files touched, commands run, duration, cost, and key excerpts. Complements get_board_status (live state) with completed-work history.", category: "issues" },
  { name: "create_issue", description: "Create a new issue on the kanban board", category: "issues" },
  { name: "create_sub_issue", description: "Create one child issue and link it to a parent with a child_of dependency in the same transaction.", category: "issues" },
  { name: "create_issues_batch", description: "Create multiple issues atomically in a single call, optionally with dependency edges between them. Returns each created issue with its assigned issueNumber. All-or-nothing: issues AND edges commit in one transaction, so autodrive can never observe a ticket before its dependency edges exist. Any validation failure rolls back.", category: "issues" },
  { name: "update_issue", description: "Update an existing issue (title, description, status, priority, type)", category: "issues" },
  { name: "delete_issue", description: "Delete an issue and all its associated data", category: "issues" },
  { name: "move_issue", description: "Move an issue to a different status column by name (e.g., 'Todo', 'In Progress', 'Done')", category: "issues" },
  { name: "attach_artifact", description: "Attach a text, link, image, or video artifact to an issue or workspace. Workspace artifacts are also tied to the workspace's issue.", category: "issues" },
  { name: "check_issue_overlap", description: "Check which files overlap between a set of issues based on their cached touched-file predictions. Returns a map of filePath → [issueIds] for files touched by more than one issue. Run analyze_touched_files on each issue first to populate the cache. Use before launching parallel workspaces to detect conflict risk.", category: "issues" },
  { name: "analyze_touched_files", description: "Predict which source files an issue will likely modify using a fast AI model. Results are cached on the issue. Re-running with refresh=true forces a new prediction.", category: "issues" },
  // workspaces
  { name: "list_workspaces", description: "List workspaces, optionally filtered by issue ID", category: "workspaces" },
  { name: "start_workspace", description: "Create a worktree-only workspace record for an issue (no agent, no status change). This does NOT launch an agent or move the issue to In Progress. To actually START work on an issue (worktree + move to In Progress + launch the agent in one step), POST to the board's /api/workspaces endpoint instead. Use this tool only when you explicitly want a bare worktree.", category: "workspaces" },
  { name: "launch_workspace", description: "Launch (or re-launch) a workspace's agent session. Mirrors CLI `workspace launch <workspace-id>`. Auto-builds the prompt from the issue title+description when no prompt is supplied. The server enforces that the workspace must be idle before launch. Prefer relaunch_workspace when you already have a custom prompt ready; use this tool when you want the default issue-derived prompt.", category: "workspaces" },
  { name: "relaunch_workspace", description: "Relaunch an idle workspace by starting a new agent session. The workspace must be in 'idle' status.", category: "workspaces" },
  { name: "wait_workspace", description: "Poll until the latest workspace for an issue reaches a terminal status (idle, ready_for_merge, closed, merged, error, or failed). Mirrors CLI `workspace wait <issue-number>` but uses a bounded DB poll instead of a WebSocket subscription so it always returns within maxWaitSeconds. Use this after launching a workspace to know when the agent is done. Returns the final status and a result field ('success' | 'error' | 'timeout').", category: "workspaces" },
  { name: "get_workspace_diff", description: "Get the git diff for a workspace's working directory", category: "workspaces" },
  { name: "get_workspace_scorecard", description: "Get the PR quality scorecard for a workspace. Returns a 0-100 score with per-dimension breakdown (Tests, Types, Scope, Diff size, Conflicts, Docs, Skill output).", category: "workspaces" },
  { name: "merge_workspace", description: "Merge a workspace branch into the project's default branch, close the workspace, and auto-transition the issue to Done. Delegates to the board server's safe merge path — per-repo merge lock, pre-merge backup/rollback, OpenSpec delta application, and conflict detection with fix-and-merge recovery — so an MCP merge has the same safety net as the UI. Requires the board server to be running.", category: "workspaces" },
  { name: "close_workspace", description: "Close a workspace without merging. For direct workspaces or abandoned work. Use merge_workspace instead if you want to merge the branch.", category: "workspaces" },
  { name: "mark_ready_for_merge", description: "Mark a workspace as reviewed and ready to merge. Call this after a successful code review with no critical or major issues. This flag allows future agents to merge the workspace without requiring another review.", category: "workspaces" },
  { name: "stop_workspace", description: "Stop any running agent session for a workspace", category: "workspaces" },
  { name: "delete_workspace", description: "Delete a workspace and all its associated data", category: "workspaces" },
  { name: "export_handoff_bundle", description: "Export a compact handoff bundle for a workspace that is stuck, awaiting review, or being transferred to a human. Returns workspace metadata, issue context, diff stats, agent summary, changed files, errors, and reviewer notes.", category: "workspaces" },
  // sessions
  { name: "list_sessions", description: "List all sessions for a workspace, including status and timing", category: "sessions" },
  { name: "recent_sessions", description: "List the most recent agent sessions across all workspaces with metadata (status, executor, workspace, issue). Mirrors `pnpm cli -- session recent`.", category: "sessions" },
  { name: "read_terminal", description: "Read agent session output (terminal messages) for a session. Returns the last N messages, stripped of ANSI codes.", category: "sessions" },
  { name: "get_session_transcript", description: "Retrieve a session transcript by session ID, including project, issue, workspace, session metadata, and ordered messages.", category: "sessions" },
  { name: "get_session_stats", description: "Get token usage, cost, and duration stats for a session", category: "sessions" },
  { name: "search_sessions", description: "Search agent session transcripts globally or within a project/issue. Use this to answer questions like how ticket ak287 was implemented and what problems the agent hit.", category: "sessions" },
  { name: "analyze_session", description: "Show a consolidated analysis of a session: workspace, issue, parsed summary with tool patterns, stats, and errors. Mirrors `pnpm cli -- session analyze <session-id>`.", category: "sessions" },
  { name: "get_fleet_friction", description: "Aggregate agent-session friction (failed tool calls, repeated commands, error counts) across all sessions in a recent time window. Use to find systemic, compounding improvements (skills/hooks/helper scripts). Reads persisted friction stats; run `session backfill-friction` first if coverage is low.", category: "sessions" },
  { name: "backfill_friction", description: "Populate friction stats (tool failures, repeated commands, errors) for past sessions from their stored messages, so friction analysis covers history. Idempotent — skips sessions that already have friction data unless force=true. Mirrors `pnpm cli -- session backfill-friction`.", category: "sessions" },
  { name: "session_history", description: "Inspect Claude Code session transcript files from ~/.claude/projects/ for worktrees linked to kanban issues. Shows what the agent did and why it stopped, without loading entire large files. Mirrors CLI `session-history [issue-number]`.", category: "sessions" },
  // tags
  { name: "list_tags", description: "List all available tags (labels) for categorizing issues", category: "tags" },
  { name: "create_tag", description: "Create a new tag (label) for categorizing issues", category: "tags" },
  // review
  { name: "review_workspace", description: "Trigger an AI code review for an idle workspace. The workspace must be in 'idle' status.", category: "review" },
  { name: "get_diff_comments", description: "Get diff review comments for a workspace, optionally filtered by file path", category: "review" },
  { name: "create_diff_comment", description: "Add a review comment on a file in a workspace's diff", category: "review" },
  { name: "approve_tool_use", description: "Internal tool used by Claude Code's --permission-prompt-tool flag. Routes tool approval requests to the agentic-kanban UI for user approval. Returns allow/deny/allow_session/deny_session.", category: "review" },
  { name: "session_review_effectiveness", description: "Measure how the ticket-implementation workflow interacts with AI code review. Reconstructs each ticket's build->review->merge lifecycle from sessions + workspaces + diff comments. Code-review agent runs are identified by triggerType 'review' or 'skill:code-review*'. Mirrors `pnpm cli -- session review-effectiveness`.", category: "review" },
  { name: "reviewer_fixes", description: "Measure how often the code-review agent FIXES findings itself (and commits) vs only approving. Two methods: git (commit author-time inside a review session's window) and deep transcript analysis (--deep). Mirrors `pnpm cli -- session reviewer-fixes`.", category: "review" },
  // dependencies
  { name: "add_dependency", description: "Add a dependency link between two issues. Types: depends_on (prerequisite), blocked_by (inverse of depends_on), related_to (symmetric link), duplicates (marks as duplicate), parent_of (parent-child), child_of (inverse of parent_of), coupled_with (symmetric peer edge: two issues touch the same code and are best implemented together). Rejects cycles for directional types and self-dependencies.", category: "dependencies" },
  { name: "remove_dependency", description: "Remove a dependency link between two issues", category: "dependencies" },
  { name: "analyze_dependencies", description: "Analyze one issue against the current board and create inferred dependency edges. Use after creating related child issues so independent tasks remain unblocked and dependent tasks stay blocked.", category: "dependencies" },
  { name: "update_dependencies_batch", description: "Add or remove multiple dependency edges atomically. Idempotent: existing add or missing remove is skipped (not failed). Cycle detection across the batch; rolls back on cycle.", category: "dependencies" },
  { name: "contract_coupled_issues", description: "Contract a full coupled_with connected component onto one lead issue. The selected issueIds must exactly match the component; external sequential dependencies are inherited by the lead and internal coupled_with edges are removed.", category: "dependencies" },
  // workflow
  { name: "propose_transition", description: "Advance the current issue's workflow to the next stage. Call this when the work for the current stage is done. Pass the workspaceId from your workflow instructions (or the issueId), the target stage name (toNodeName), and a short summary of what you completed.", category: "workflow" },
  { name: "clarify_or_propose", description: "For workflow phase skills: either raise a structured clarifying question in the interactive UI, or propose the next workflow gate.", category: "workflow" },
  { name: "list_workflow_templates", description: "List workflow templates available to a project (project-scoped + global built-ins). Returns id, name, ticketType, isBuiltin, and stage/edge counts.", category: "workflow" },
  { name: "get_workflow_template", description: "Get a workflow template's full graph (nodes + edges) by id.", category: "workflow" },
  { name: "create_workflow_template", description: "Create a project workflow template (graph of stages + transitions). Each node maps to a board status and may attach a skill by name. Exactly one 'start', at least one 'end', no orphan nodes; a 'parallel-fork' needs a matching 'parallel-join'. Edges support conditions (manual/auto_on_exit_0/tests_pass/tests_fail/diff_clean/diff_touches). Use node-type 'parallel-fork' to run branches concurrently (e.g. parallel research) and 'parallel-join' to consolidate.", category: "workflow" },
  { name: "update_workflow_template", description: "Update a non-built-in workflow template. Pass nodes+edges together to replace the graph (validated). Built-in templates cannot be edited — duplicate via create_workflow_template first.", category: "workflow" },
  { name: "delete_workflow_template", description: "Delete a non-built-in workflow template (cascades its nodes + edges).", category: "workflow" },
  // skills
  { name: "list_agent_skills", description: "List all available agent skills that can be applied to workspaces", category: "skills" },
  { name: "get_agent_skill", description: "Get full details of an agent skill including its prompt", category: "skills" },
  { name: "create_agent_skill", description: "Create a new agent skill with a name, description, and prompt template", category: "skills" },
  { name: "export_agent_skills", description: "Export agent skills as SKILL.md files for Claude Code and Codex. Writes .claude/skills and links .codex/skills to the same directory.", category: "skills" },
  { name: "install_skill", description: "Install built-in agent skills as SKILL.md files into a project's .claude/skills/ directory and link .codex/skills to the same location. Mirrors CLI `install-skill [target-path]`. Reads built-in global skills from the DB (requires db:seed to have run). Each skill is written as <targetPath>/.claude/skills/<name>/SKILL.md.", category: "skills" },
  // specs
  { name: "openspec_list_specs", description: "List the living OpenSpec domains for a project. Use this before answering project architecture or behavior questions from specs.", category: "specs" },
  { name: "show_spec", description: "Show a living OpenSpec domain spec for a project. Butler answers about how the project works should cite this content when applicable.", category: "specs" },
  { name: "validate_change", description: "Validate OpenSpec change deltas under openspec/changes. Checks ADDED/MODIFIED/REMOVED sections and warns about same-domain delta collisions.", category: "specs" },
  // drives
  { name: "start_drive", description: "Start a Drive: a first-class record of an autonomous epic push toward a target under a completion contract. Creates a Drive record (status='active') that survives a server restart and is queryable via list_drives/get_drive.", category: "drives" },
  { name: "list_drives", description: "List all Drives for a project (most recently started first). A Drive records an autonomous epic push: its target, completion contract, status (active/completed/abandoned), and start/finish times.", category: "drives" },
  { name: "get_drive", description: "Get a single Drive by ID, including its target, completion contract, status, and start/finish timestamps.", category: "drives" },
  { name: "finish_drive", description: "Finish a Drive: set a terminal status ('completed' or 'abandoned') and stamp finishedAt. Use when the epic is fully merged (completed) or the drive is given up (abandoned).", category: "drives" },
  { name: "drive_review_effectiveness", description: "Get AI code-review effectiveness metrics for a Drive: reviews run, reviews that bounced a ticket back to building, and tickets merged without any review. Scoped to the drive's time window and — when the drive has a meta-issue — to that meta-issue's dependency subtree (pass wholeProject=true to ignore the subtree restriction). Mirrors CLI `drive review-effectiveness <drive-id>`.", category: "drives" },
  // projects
  { name: "register_project", description: "Register an existing git repository as a project on the kanban board. Auto-detects repo name, default branch, and remote URL. Creates the default statuses (Backlog, Todo, In Progress, In Review, AI Reviewed, Done, Cancelled) and sets the project as active. If the repo is already registered, returns the existing project.", category: "projects" },
  { name: "create_project", description: "Create a new directory, initialize it as a git repository, and register it as a project on the kanban board. Use register_project instead if the repo already exists. The directory is created inside the configured projects_base_path preference unless an explicit path is provided.", category: "projects" },
  { name: "list_projects", description: "List all registered projects on the kanban board. Shows project name, ID, repo path, default branch, and remote URL. The currently active project is indicated in the result.", category: "projects" },
  { name: "unregister_project", description: "Remove a project registration from the kanban board by name or project ID. Cascade-deletes all associated data: issues, workspaces, sessions, issue tags, and project statuses. This is irreversible — use with care.", category: "projects" },
  { name: "cleanup_project", description: "Report stale git worktrees for closed/merged workspaces in a project. Lists workspace branches and their worktree paths so they can be removed manually with 'git worktree remove --force <path>'. This tool does NOT auto-remove worktrees — it only reports them. Omit projectId to scan all projects.", category: "projects" },
  { name: "init_project", description: "Initialize and register a git repository as a project on the kanban board. Mirrors CLI `init [path]`. The server must already be running (the MCP server itself being active satisfies this). If no path is provided, only confirms the server is reachable and migrations are up to date.", category: "projects" },
  // settings
  { name: "get_preference", description: "Get a preference value by key. Mirrors CLI `preferences get <key>`. Returns the stored value string, or a message indicating it is not set.", category: "settings" },
  { name: "set_preference", description: "Set (upsert) a preference value by key. Mirrors CLI `preferences set <key> <value>`. Writes directly to the preferences table. Use get_preference to read it back.", category: "settings" },
  // butler
  { name: "ask_butler", description: "Ask the project butler — a warm, persistent Claude assistant running in the project's repo — a question and get its answer back. Use for quick questions about the project, codebase, or board without spawning a new workspace. Maintains conversation context across calls.", category: "butler" },
  { name: "butler_ensure", description: "Start (warm) the butler session for a project if it is not already running. Equivalent to CLI `butler ensure`. Safe to call repeatedly — no-ops when the butler is already warm.", category: "butler" },
  { name: "butler_stop", description: "Stop the butler's warm session and forget its resume id. The butler can be restarted later via butler_ensure. Equivalent to CLI `butler stop`.", category: "butler" },
  { name: "butler_list", description: "List all defined butlers and their per-project runtime state (warm/stopped, session id). Equivalent to CLI `butler list`.", category: "butler" },
  { name: "butler_interrupt", description: "Interrupt the butler's in-flight turn. The warm session is preserved (context is kept); only the current response generation is cancelled.", category: "butler" },
  { name: "butler_state", description: "Get the butler's current state for a project: whether the warm session is active, current model/profile selection, context-window usage, and MCP connection status.", category: "butler" },
  { name: "butler_set_model", description: "Switch the butler's model live (no session restart, context preserved). Pass an empty model string to revert to the profile/CLI default.", category: "butler" },
  { name: "butler_set_profile", description: "Switch the butler's Claude profile. This restarts the warm session (different auth/endpoint cannot resume). Pass an empty profile to revert to the global default.", category: "butler" },
  { name: "get_butler_skill", description: "Get the butler's editable system prompt (skill) for a project. Returns the prompt text and whether it is a project-scoped override or the global default. Equivalent to CLI `butler skill get`.", category: "butler" },
  { name: "set_butler_skill", description: "Set (upsert) the butler's system prompt (skill) for a project, creating a project-scoped override. Pass an empty string to reset to the global default. Equivalent to CLI `butler skill set <prompt>`.", category: "butler" },
];
