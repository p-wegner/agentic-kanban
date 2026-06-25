// `Settings`, `DEFAULT_SETTINGS`, and the typed accessors are DERIVED from the single
// settings registry (`@agentic-kanban/shared/lib/settings-registry`, #903) — the same
// source the server's SETTINGS_KEYS whitelist derives from. Adding a global setting is
// now a one-place edit in that registry; a setting referenced here but absent there is a
// compile error. Re-exported so existing client imports (`from "./settings-shared.js"`,
// or transitively `SettingsPanel.shared.js`) keep working unchanged.
export {
  SETTINGS_REGISTRY,
  SETTINGS_REGISTRY_KEYS,
  DEFAULT_SETTINGS,
  getBool,
  getNumber,
  getJson,
} from "@agentic-kanban/shared/lib/settings-registry";
export type { Settings, SettingKey, SettingDef, SettingType } from "@agentic-kanban/shared/lib/settings-registry";
import type { Settings } from "@agentic-kanban/shared/lib/settings-registry";

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
  // Provider-scoped only (#902) — no fallback to a global `default_model`, which is gone.
  return settings[key] || "";
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
