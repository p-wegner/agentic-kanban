import type { ProfileSelection } from "@agentic-kanban/shared";
import { AGENT_PROVIDER_NAMES, PROVIDER_TRAITS, providerLabel } from "@agentic-kanban/shared/lib/provider-traits";
import { WORKSPACE_STATUS_TONE, workspaceStatusToneClass } from "./badgeTones.js";

export type AgentProvider = ProfileSelection["provider"];

export const COPILOT_DEFAULT_PROFILE = "default";
export const CODEX_DEFAULT_PROFILE = "default";
export const PI_DEFAULT_PROFILE = "default";

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

// #517: derived from the status tones — four of these rows were light-only.
export const STATUS_COLORS: Record<string, string> = Object.fromEntries(
  Object.keys(WORKSPACE_STATUS_TONE).map((status) => [status, workspaceStatusToneClass(status)]),
);

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

// #493: one row per provider. Re-exported so this module's importers are unchanged.
export { providerLabel };

export function profileSelectionFromValue(value: string): ProfileSelection | undefined {
  const colonIdx = value.indexOf(":");
  if (colonIdx === -1) return undefined;
  const provider = value.slice(0, colonIdx);
  const name = value.slice(colonIdx + 1);
  // #493: deliberately NOT `narrowProvider` — this parses UNTRUSTED input and must
  // REJECT an unknown provider, where narrowProvider falls back to claude. Silently
  // reinterpreting "opencode:foo" as a claude profile is exactly the wrong answer here.
  if (!(AGENT_PROVIDER_NAMES as readonly string[]).includes(provider) || !name) return undefined;
  return { provider: provider as AgentProvider, name };
}

/**
 * The dropdown's selected VALUE — not a label.
 *
 * #493: this looks like `defaultProfileToken` and is not. Claude with no configured
 * profile yields `""` ("no explicit selection; let the server resolve it"), where the
 * label helper yields the display string `claude:none`. Folding the two together would
 * start SUBMITTING `claude:none` as a profile name. Only the pref-key lookup is shared.
 */
export function defaultSelectedProfile(settings: Record<string, string>): string {
  const provider = settings.provider;
  if (provider === "claude" || !provider) {
    return settings.claude_profile ? `claude:${settings.claude_profile}` : "";
  }
  const traits = PROVIDER_TRAITS[provider as AgentProvider];
  if (!traits) return settings.claude_profile ? `claude:${settings.claude_profile}` : "";
  return `${provider}:${settings[traits.profilePrefKey] || traits.defaultProfile}`;
}

/**
 * Resolve the "Default" quick-launch profile to an explicit {provider, name}
 * so the server doesn't fall through to Strategy Bullseye — keeping the
 * displayed profile in sync with what actually runs.
 * Returns undefined when no specific default exists (pure Claude, no profile).
 */
export function resolveQuickLaunchDefault(prefs: Record<string, string>): { provider: AgentProvider; name: string } | undefined {
  // Same claude asymmetry as defaultSelectedProfile: `undefined` means "no specific
  // default", which is a real state and NOT `{provider:"claude", name:"none"}`.
  const provider = prefs.provider;
  if (provider && provider !== "claude") {
    const traits = PROVIDER_TRAITS[provider as AgentProvider];
    if (traits) return { provider: provider as AgentProvider, name: prefs[traits.profilePrefKey] || traits.defaultProfile };
  }
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
