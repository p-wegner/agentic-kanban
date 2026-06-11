import type { ProfileSelection } from "@agentic-kanban/shared";

export type AgentProvider = ProfileSelection["provider"];

export const COPILOT_DEFAULT_PROFILE = "default";
export const CODEX_DEFAULT_PROFILE = "default";

export type ProfileOption = {
  provider: AgentProvider;
  name: string;
};

export interface SessionStats {
  durationMs: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  model: string;
  success: boolean;
}

export const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  reviewing: "bg-accent-50 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300",
  fixing: "bg-orange-100 text-orange-700",
  idle: "bg-yellow-100 text-yellow-700",
  "awaiting-plan-approval": "bg-amber-100 text-amber-700",
  error: "bg-red-100 text-red-700",
  closed: "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400",
};

export const SESSION_STATUS_COLORS: Record<string, string> = {
  running: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  stopped: "bg-yellow-100 text-yellow-700",
};

export const TRIGGER_TYPE_LABELS: Record<string, { label: string; className: string }> = {
  agent: { label: "Agent", className: "bg-blue-50 text-blue-600" },
  chat: { label: "Chat", className: "bg-indigo-50 text-indigo-600" },
  review: { label: "AI Review", className: "bg-accent-50 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300" },
  merge: { label: "AI Merge", className: "bg-emerald-100 text-emerald-700" },
  "fix-conflicts": { label: "Fix Conflicts", className: "bg-orange-100 text-orange-700" },
  "fix-and-merge": { label: "Fix & Merge", className: "bg-orange-100 text-orange-700" },
  bisect: { label: "Auto-bisect", className: "bg-rose-100 text-rose-700" },
  learning: { label: "Learning", className: "bg-teal-100 text-teal-700" },
  "auto-start": { label: "Auto-start", className: "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400" },
};

export function profileOptionValue(option: ProfileOption): string {
  return `${option.provider}:${option.name}`;
}

export function uniqueProfileOptions(options: ProfileOption[]): ProfileOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    const value = profileOptionValue(option);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

export function providerLabel(provider?: string | null): string {
  if (provider === "codex") return "Codex";
  if (provider === "copilot") return "Copilot";
  return "Claude";
}

export function profileSelectionFromValue(value: string): ProfileSelection | undefined {
  const colonIdx = value.indexOf(":");
  if (colonIdx === -1) return undefined;
  const provider = value.slice(0, colonIdx) as AgentProvider;
  const name = value.slice(colonIdx + 1);
  if ((provider !== "claude" && provider !== "codex" && provider !== "copilot") || !name) return undefined;
  return { provider, name };
}

export function defaultSelectedProfile(settings: Record<string, string>): string {
  if (settings.provider === "codex") return `codex:${settings.codex_profile || CODEX_DEFAULT_PROFILE}`;
  if (settings.provider === "copilot") return `copilot:${settings.copilot_profile || COPILOT_DEFAULT_PROFILE}`;
  if (settings.claude_profile) return `claude:${settings.claude_profile}`;
  return "";
}

/**
 * Resolve the "Default" quick-launch profile to an explicit {provider, name}
 * so the server doesn't fall through to Strategy Bullseye — keeping the
 * displayed profile in sync with what actually runs.
 * Returns undefined when no specific default exists (pure Claude, no profile).
 */
export function resolveQuickLaunchDefault(prefs: Record<string, string>): { provider: AgentProvider; name: string } | undefined {
  if (prefs.provider === "codex") return { provider: "codex", name: prefs.codex_profile || CODEX_DEFAULT_PROFILE };
  if (prefs.provider === "copilot") return { provider: "copilot", name: prefs.copilot_profile || COPILOT_DEFAULT_PROFILE };
  if (prefs.claude_profile) return { provider: "claude", name: prefs.claude_profile };
  return undefined;
}

const SKILL_NAME_ACRONYMS = new Set(["ui", "ai", "api", "llm", "url", "http", "id"]);
export function humanizeSkillName(name: string): string {
  return name.replace(/[-_]/g, " ").replace(/\b\w+/g, w =>
    SKILL_NAME_ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)
  );
}

export function getTriggerTypeLabel(triggerType: string | null, skillName?: string | null): { label: string; className: string } | null {
  if (!triggerType) {
    if (skillName) return { label: `✨ ${humanizeSkillName(skillName)}`, className: "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300" };
    return null;
  }
  if (TRIGGER_TYPE_LABELS[triggerType]) return TRIGGER_TYPE_LABELS[triggerType];
  if (triggerType.startsWith("skill:")) {
    const name = triggerType.slice(6);
    return { label: `✨ ${humanizeSkillName(name)}`, className: "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300" };
  }
  return null;
}

export function formatDuration(start: string, end: string | null): string {
  if (!end) return "running";
  const diffMs = new Date(end).getTime() - new Date(start).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s`;
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function parseStats(statsStr: string | null | undefined): SessionStats | null {
  if (!statsStr) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(statsStr);
  } catch {
    return null;
  }
  // The stats column also holds non-token shapes (e.g. `{ friction: {...} }`
  // written by some providers). Only treat it as SessionStats when the numeric
  // fields the badges read are actually present; otherwise `s.inputTokens
  // .toLocaleString()` throws and, with no error boundary, blanks the whole app.
  if (!parsed || typeof parsed !== "object") return null;
  const s = parsed as Record<string, unknown>;
  const hasTokenStats =
    typeof s.durationMs === "number" &&
    typeof s.totalCostUsd === "number" &&
    typeof s.inputTokens === "number" &&
    typeof s.outputTokens === "number" &&
    typeof s.numTurns === "number";
  return hasTokenStats ? (parsed as SessionStats) : null;
}
