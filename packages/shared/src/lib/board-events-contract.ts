/**
 * The board WebSocket vocabulary and message union, declared once (#566).
 *
 * `BoardEventType` and the seven message interfaces lived in
 * `server/src/services/board-events.ts`, importable by nobody else. So:
 *
 *  - `POST /api/internal/board-notify` accepted `reason?: string` and CAST it to
 *    `BoardEventType`, while the MCP server sent 28 reasons that were not in the union;
 *  - the client re-declared the whole union by hand in `lib/useBoardEvents.ts`, with
 *    drift (`reason: string`, an optional `subagentCount` the server always sends);
 *  - five files hand-built a `RELEVANT_REASONS = new Set<string>([...])` filter, and
 *    three of them listed `"workspace_updated"` — a reason no server code has ever
 *    broadcast, so that member had been filtering nothing since the day it was written.
 *
 * The named groups below replace those hand-built sets. They are `ReadonlySet`s of the
 * union, so a typo is a compile error and a retired reason cannot linger in a filter.
 */

/** Reasons the server itself broadcasts. */
export const SERVER_BOARD_EVENT_REASONS = [
  "board_changed",
  "issue_created",
  "issue_updated",
  "issue_deleted",
  "dependency_added",
  "dependency_removed",
  "session_completed",
  "session_launched",
  "session_stopped",
  "workspace_created",
  "workspace_setup",
  "workspace_idle",
  "workspace_merged",
  "workspace_closed",
  "workspace_ready_for_merge",
  "workflow_error",
  "workflow_fork",
  "workflow_join",
  "workflow_template_saved",
  "workflow_template_deleted",
  "workflow_transition",
  "drive_obstacle",
  "project_completed",
  "internal_notify",
] as const;

/**
 * Reasons the MCP server and the drive tooling POST to `/api/internal/board-notify`.
 * They travel on the same channel and were simply absent from the type.
 */
export const EXTERNAL_BOARD_EVENT_REASONS = [
  "drive_started",
  "drive_finished",
  "mcp_attach_artifact",
  "mcp_clarify_or_propose_transition",
  "mcp_clarifying_question",
  "mcp_close_workspace",
  "mcp_create_issue",
  "mcp_create_issues_batch",
  "mcp_create_sub_issue",
  "mcp_create_workflow_template",
  "mcp_delete_issue",
  "mcp_delete_status",
  "mcp_delete_workflow_template",
  "mcp_delete_workspace",
  "mcp_dependency_added",
  "mcp_dependency_removed",
  "mcp_import_backlog_markdown",
  "mcp_issue_updated",
  "mcp_launch_workspace",
  "mcp_move_issue",
  "mcp_propose_ticket_groups",
  "mcp_propose_transition",
  "mcp_relaunch_workspace",
  "mcp_review_workspace",
  "mcp_start_workspace",
  "mcp_stop_workspace",
  "mcp_update_issue",
  "mcp_update_workflow_template",
] as const;

/** Kept separate: these three are the only reasons on the `projects_changed` message. */
export const PROJECT_EVENT_REASONS = ["project_created", "project_updated", "project_deleted"] as const;
export type ProjectEventReason = (typeof PROJECT_EVENT_REASONS)[number];

export const BOARD_EVENT_REASONS = [...SERVER_BOARD_EVENT_REASONS, ...EXTERNAL_BOARD_EVENT_REASONS] as const;
export type BoardEventReason = (typeof BOARD_EVENT_REASONS)[number];


/**
 * Reasons the client synthesizes locally to drive the same refresh path as a real
 * event. They are never sent by the server as a `board_changed` reason.
 *
 * `plugin_gate` is the odd one: it IS a wire message, but a message TYPE, not a reason —
 * the client replays it as a refresh reason so panels refetch and the approval card
 * appears without a reload. Naming it here is what made that visible; typing the
 * vocabulary is what forced the question.
 */
export const CLIENT_SYNTHETIC_REASONS = ["reconnect", "poll", "plugin_gate"] as const;
export type ClientSyntheticReason = (typeof CLIENT_SYNTHETIC_REASONS)[number];
/**
 * Everything a client-side refresh handler can be handed: a `board_changed` reason, a
 * `projects_changed` reason (both arrive on the same callback), or one of the synthetic
 * ones above. This is the type to use for a `shouldRefetch`-style filter.
 */
export type ClientRefreshReason = BoardEventReason | ProjectEventReason | ClientSyntheticReason;

const REASON_SET: ReadonlySet<string> = new Set(BOARD_EVENT_REASONS);

export function isBoardEventReason(value: unknown): value is BoardEventReason {
  return typeof value === "string" && REASON_SET.has(value);
}

/** A workspace was created, changed state, or finished. */
export const WORKSPACE_LIFECYCLE_REASONS: ReadonlySet<ClientRefreshReason> = new Set([
  "workspace_created",
  "workspace_setup",
  "workspace_idle",
  "workspace_merged",
  "workspace_closed",
  "workspace_ready_for_merge",
] as const);

/** An agent session started, stopped, or finished. */
export const SESSION_LIFECYCLE_REASONS: ReadonlySet<ClientRefreshReason> = new Set([
  "session_launched",
  "session_stopped",
  "session_completed",
] as const);

/** A workflow node/template changed. */
export const WORKFLOW_REASONS: ReadonlySet<ClientRefreshReason> = new Set([
  "workflow_error",
  "workflow_fork",
  "workflow_join",
  "workflow_transition",
  "workflow_template_saved",
  "workflow_template_deleted",
] as const);

/** A drive (Conductor/board-monitor) started, finished, or hit an obstacle. */
export const DRIVE_REASONS: ReadonlySet<ClientRefreshReason> = new Set([
  "drive_started",
  "drive_finished",
  "drive_obstacle",
] as const);

/**
 * What a live cross-repo/fleet view refetches on: anything that moves a workspace or a
 * session, plus the generic `board_changed`, plus the client's own reconnect/poll.
 *
 * This replaces three near-identical hand-built sets. Two of them omitted
 * `workspace_idle` and `workspace_ready_for_merge` while the third had them — an
 * inconsistency with no reason behind it, so the union is used; those views now also
 * refetch when a workspace goes idle or becomes ready, which is what they display.
 */
export const LIVE_ACTIVITY_REFRESH_REASONS: ReadonlySet<ClientRefreshReason> = new Set<ClientRefreshReason>([
  "board_changed",
  ...WORKSPACE_LIFECYCLE_REASONS,
  ...SESSION_LIFECYCLE_REASONS,
  ...CLIENT_SYNTHETIC_REASONS,
]);

// ---------------------------------------------------------------------------
// The message union. Moved verbatim from server/src/services/board-events.ts.
// ---------------------------------------------------------------------------

export interface BoardChangedMessage {
  type: "board_changed";
  projectId: string;
  reason: BoardEventReason;
}

export interface ProjectsChangedMessage {
  type: "projects_changed";
  projectId: string;
  reason: ProjectEventReason;
}

export interface SessionActivityMessage {
  type: "session_activity";
  projectId: string;
  issueId: string;
  sessionId: string;
  activity: string;
}

export interface SessionStatsMessage {
  type: "session_stats";
  projectId: string;
  issueId: string;
  model: string;
  contextTokens: number;
  toolUses: number;
  subagentCount: number;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

export interface SessionTodosMessage {
  type: "session_todos";
  projectId: string;
  issueId: string;
  todos: TodoItem[];
}

export interface ApprovalRequestMessage {
  type: "approval_requested";
  projectId: string;
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  workspaceId?: string;
}

/**
 * A plugin loop reached a human-approval gate (#287). Emitted once per NEW gate id —
 * the monitor re-plans a blocked loop every cycle, and re-notifying on every poll would
 * train the user to ignore it.
 */
export interface PluginGateMessage {
  type: "plugin_gate";
  projectId: string;
  pluginSlug: string;
  pluginName: string;
  /** Plugin ROW id (#300) — what a receiver needs to deep-link to the loop pane;
   *  null only on advance paths that don't know their row (none in practice). */
  pluginId: string | null;
  loopName: string;
  loopLabel: string;
  gateId: string;
  question: string;
}

export type BoardWsMessage =
  | BoardChangedMessage
  | ProjectsChangedMessage
  | SessionActivityMessage
  | SessionStatsMessage
  | SessionTodosMessage
  | ApprovalRequestMessage
  | PluginGateMessage;
