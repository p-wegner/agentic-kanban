export interface Settings {
  agent_command?: string;
  agent_args?: string;
  output_parser?: string;
  skip_permissions?: string;
  claude_profile?: string;
  codex_profile?: string;
  copilot_profile?: string;
  pi_profile?: string;
  codex_license_ring?: string;
  codex_license_rotation?: string;
  claude_subscription_ring?: string;
  claude_subscription_rotation?: string;
  provider?: string;
  default_model?: string;
  default_model_claude?: string;
  default_model_codex?: string;
  default_model_pi?: string;
  permission_prompt_tool?: string;
  auto_review?: string;
  auto_merge?: string;
  merge_strategy?: string;
  auto_merge_in_review?: string;
  review_auto_fix?: string;
  resume_with_new_model?: string;
  disabled_mcp_tools?: string;
  auto_start_followup?: string;
  dependency_auto_chain?: string;
  auto_rebase_on_continue?: string;
  require_manual_approval?: string;
  skip_preflight?: string;
  dynamic_column_scaling?: string;
  persistent_agent?: string;
  learning_step_after_agent?: string;
  learning_step_after_review?: string;
  learning_step_before_merge?: string;
  auto_monitor?: string;
  auto_monitor_interval?: string;
  nudge_auto_start?: string;
  nudge_wip_limit?: string;
  monitor_maintenance_window_enabled?: string;
  monitor_maintenance_window_end?: string;
  auto_commit_strategy_objective?: string;
  backlog_stale_days?: string;
  inprogress_stale_days?: string;
  backlog_empty_strategy?: string;
  backlog_empty_skill?: string;
  backlog_empty_cooldown_min?: string;
  projects_base_path?: string;
  plan_auto_continue?: string;
  visual_verification_mode?: string;
  after_merge_verify_agent?: string;
  butler_event_feed?: string;
  butler_event_feed_min_interval_ms?: string;
  butler_auto_answer?: string;
  butler_auto_answer_min_confidence?: string;
  "harness.codex.plan_auto_continue"?: string;
  "harness.copilot.plan_auto_continue"?: string;
  "harness.claude.plan_auto_continue"?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  agent_command: "",
  agent_args: "",
  output_parser: "minimal",
  skip_permissions: "true",
  claude_profile: "",
  codex_profile: "",
  copilot_profile: "",
  pi_profile: "",
  codex_license_ring: "",
  codex_license_rotation: "true",
  claude_subscription_ring: "",
  claude_subscription_rotation: "true",
  provider: "claude",
  default_model: "",
  default_model_claude: "",
  default_model_codex: "",
  default_model_pi: "",
  permission_prompt_tool: "false",
  auto_review: "true",
  auto_merge: "true",
  merge_strategy: "",
  auto_merge_in_review: "false",
  review_auto_fix: "true",
  resume_with_new_model: "false",
  disabled_mcp_tools: "",
  auto_start_followup: "false",
  dependency_auto_chain: "false",
  auto_rebase_on_continue: "false",
  require_manual_approval: "false",
  skip_preflight: "false",
  dynamic_column_scaling: "false",
  persistent_agent: "false",
  learning_step_after_agent: "false",
  learning_step_after_review: "false",
  learning_step_before_merge: "false",
  auto_monitor: "false",
  auto_monitor_interval: "4",
  nudge_auto_start: "false",
  monitor_maintenance_window_enabled: "false",
  monitor_maintenance_window_end: "",
  auto_commit_strategy_objective: "true",
  backlog_stale_days: "14",
  inprogress_stale_days: "3",
  backlog_empty_strategy: "skip",
  backlog_empty_skill: "architecture-improvement",
  backlog_empty_cooldown_min: "120",
  projects_base_path: "",
  plan_auto_continue: "true",
  visual_verification_mode: "before_merge",
  butler_event_feed: "false",
  butler_event_feed_min_interval_ms: "30000",
  butler_auto_answer: "false",
};

export type MonitorTunables = {
  activeAgentsTarget: number;
  backlogFloor: number;
  maxNewStartsPerCycle: number;
  refillFocus: "bugfix-only" | "balanced";
};

export type Tab = "agent" | "workflow" | "skills" | "mcp" | "ui" | "project" | "tags" | "templates" | "advanced" | "schedule";

export const TABS: { id: Tab; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "workflow", label: "Workflow" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP Tools" },
  { id: "ui", label: "UI" },
  { id: "project", label: "Project" },
  { id: "tags", label: "Tags" },
  { id: "templates", label: "Templates" },
  { id: "schedule", label: "Schedule" },
  { id: "advanced", label: "Advanced" },
];

export type AgentProvider = "claude" | "codex" | "copilot" | "pi";

export const COPILOT_DEFAULT_PROFILE = "default";
export const CODEX_DEFAULT_PROFILE = "default";
export const PI_DEFAULT_PROFILE = "default";

export function defaultModelKeyForProvider(provider: AgentProvider): keyof Settings | null {
  if (provider === "claude") return "default_model_claude";
  if (provider === "codex") return "default_model_codex";
  if (provider === "pi") return "default_model_pi";
  return null;
}

export function defaultModelForProvider(settings: Settings | Record<string, string>, provider: AgentProvider): string {
  const key = defaultModelKeyForProvider(provider);
  if (!key) return "";
  return settings[key] || settings.default_model || "";
}

export type AgentProfileHealth = {
  id: string;
  provider: AgentProvider;
  profileName: string;
  command: string;
  selected: boolean;
  status: "ok" | "warning" | "error" | "unknown";
  preflight: {
    ok: boolean;
    status: "ok" | "warning" | "error" | "unknown";
    errors: string[];
    warnings: string[];
    command: string;
    provider: AgentProvider;
    profileName: string;
    flags: string[];
    /** CLI version probe verdict (optional — older server builds omit it). */
    version?: {
      detected: boolean;
      raw: string | null;
      version: string | null;
      status: "ok" | "below-min" | "above-known" | "unparseable" | "unavailable";
      message: string | null;
    } | null;
  };
  latestFailure: {
    at: string;
    summary: string;
    exitCode?: number | null;
  } | null;
};

export type McpHealth = {
  server: {
    name: string;
    command: string;
    args: string[];
    cwd: string | null;
    path: string | null;
  };
  lastProbe: {
    ok: boolean;
    status: "ok" | "warning" | "error" | "unknown";
    checkedAt: string;
    durationMs: number;
    toolCount: number | null;
    error: {
      code: "missing_binary" | "bad_cwd" | "timeout" | "malformed_json_rpc" | "process_error";
      message: string;
      detail?: string;
    } | null;
  } | null;
};

export function uniqueProfiles(profiles: string[], fallback?: string): string[] {
  const all = fallback ? [fallback, ...profiles] : profiles;
  return [...new Set(all.filter(Boolean))];
}

export function settingsProfileValue(settings: Settings): string {
  const provider = (settings.provider || "claude") as AgentProvider;
  if (provider === "codex") return `codex:${settings.codex_profile || CODEX_DEFAULT_PROFILE}`;
  if (provider === "copilot") return `copilot:${settings.copilot_profile || COPILOT_DEFAULT_PROFILE}`;
  if (provider === "pi") return `pi:${settings.pi_profile || PI_DEFAULT_PROFILE}`;
  return `claude:${settings.claude_profile || ""}`;
}

export function profileOptionLabel(provider: AgentProvider, name: string): string {
  const isDefault = (provider === "copilot" && name === COPILOT_DEFAULT_PROFILE) ||
    (provider === "codex" && name === CODEX_DEFAULT_PROFILE) ||
    (provider === "pi" && name === PI_DEFAULT_PROFILE);
  const displayName = isDefault ? "Default" : name;
  const providerLabel = providerDisplayName(provider);
  return `${providerLabel}: ${displayName}`;
}

export function defaultHarnessLabel(settings: Settings): string {
  const provider = (settings.provider || "claude") as AgentProvider;
  if (provider === "codex") return "Codex";
  if (provider === "copilot") return "Copilot";
  if (provider === "pi") return "Pi";
  return "Claude";
}

export function providerDisplayName(provider: AgentProvider): string {
  if (provider === "codex") return "Codex";
  if (provider === "copilot") return "Copilot";
  if (provider === "pi") return "Pi";
  return "Claude";
}

export type CapabilityKey = "planMode" | "resume" | "mcpTools" | "visualVerify" | "permissionPrompts";

export interface ProviderCapabilityDef {
  key: CapabilityKey;
  label: string;
  tooltip: string;
}

export const CAPABILITY_DEFS: ProviderCapabilityDef[] = [
  { key: "planMode", label: "Plan mode", tooltip: "Supports a read-only planning pass before executing changes." },
  { key: "resume", label: "Resume", tooltip: "Can resume a previous session using its session ID." },
  { key: "mcpTools", label: "MCP tools", tooltip: "Can load and invoke external MCP server tools." },
  { key: "visualVerify", label: "Visual verify", tooltip: "Supports visual verification via browser control." },
  { key: "permissionPrompts", label: "Permission prompts", tooltip: "Supports interactive tool-use permission prompts." },
];

export type CapabilityMatrix = Record<CapabilityKey, boolean>;

export function getProviderCapabilities(provider: AgentProvider, profileName: string, flags: string[]): CapabilityMatrix {
  const isMock = provider === "claude" && profileName === "mock";
  if (isMock) {
    return { planMode: true, resume: true, mcpTools: true, visualVerify: true, permissionPrompts: false };
  }
  if (provider === "codex") {
    return { planMode: true, resume: true, mcpTools: true, visualVerify: true, permissionPrompts: false };
  }
  if (provider === "copilot") {
    return { planMode: true, resume: true, mcpTools: true, visualVerify: true, permissionPrompts: false };
  }
  if (provider === "pi") {
    return { planMode: true, resume: true, mcpTools: true, visualVerify: true, permissionPrompts: false };
  }
  // claude
  const hasPermissionPromptTool = flags.some((f) => f.startsWith("--permission-prompt-tool"));
  return { planMode: true, resume: true, mcpTools: true, visualVerify: true, permissionPrompts: hasPermissionPromptTool };
}

export function statusClasses(status: AgentProfileHealth["status"]): string {
  if (status === "error") return "bg-red-50 text-red-700 border-red-200";
  if (status === "warning") return "bg-amber-50 text-amber-700 border-amber-200";
  if (status === "ok") return "bg-green-50 text-green-700 border-green-200";
  return "bg-gray-50 text-gray-600 border-gray-200";
}

export function formatHealthTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-US");
}

/**
 * Apply a preflight result to the matching profile-health row. A row that already
 * has a recorded latestFailure stays "error" even when the preflight itself passes
 * (failure-wins); otherwise it takes the preflight's status.
 */
export function applyPreflightResult(
  rows: AgentProfileHealth[],
  profileId: string,
  result: AgentProfileHealth["preflight"],
): AgentProfileHealth[] {
  return rows.map((row) =>
    row.id === profileId
      ? { ...row, preflight: result, status: row.latestFailure ? "error" : result.status, command: result.command }
      : row,
  );
}
