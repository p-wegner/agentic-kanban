import { ACCENT, BRAND } from "./chartColors";
import type { IssueWithStatus } from "@agentic-kanban/shared";

export type SegmentKind = "work-type" | "provider" | "area" | "custom";
export type Provider = "" | "claude" | "codex" | "copilot" | "pi";
export type ProviderPolicyMode = "fill" | "throttle" | "fallback-only";

export interface StrategySegment {
  id: string;
  label: string;
  description: string;
  kind: SegmentKind;
  weight: number;
  color: string;
  keywords: string;
  provider: Provider;
}

export interface ProviderProfilePolicy {
  id: string;
  provider: "claude" | "codex" | "copilot" | "pi";
  profileName: string;
  label: string;
  mode: ProviderPolicyMode;
  headroomPct: number;
  notes: string;
  /** Optional quota provider ID from the tampermonkey-direct /api/usage response. When set, live usage gates this policy. */
  quotaProviderId: string;
}

export interface StrategyConfig {
  version: number;
  activeAgentsTarget: number;
  backlogFloor: number;
  maxNewStartsPerCycle: number;
  segments: StrategySegment[];
  providerPolicies: ProviderProfilePolicy[];
}

export const DEFAULT_CONFIG: StrategyConfig = {
  version: 1,
  activeAgentsTarget: 4,
  backlogFloor: 10,
  maxNewStartsPerCycle: 2,
  segments: [
    { id: "work-bugfix", label: "Bugfix", description: "Real, reproducible defects and regressions.", kind: "work-type", weight: 5, color: BRAND, keywords: "bug bugfix fix defect regression", provider: "" },
    { id: "work-feature", label: "Feature", description: "New product capability and workflow improvements.", kind: "work-type", weight: 3, color: "#5b7a8c", keywords: "feature enhancement product workflow", provider: "" },
    { id: "work-quality", label: "Quality", description: "Reliability, safeguards, and review improvements.", kind: "work-type", weight: 3, color: ACCENT, keywords: "quality reliability guardrail review", provider: "" },
    { id: "work-ux", label: "UX", description: "Interface polish, usability, and interaction design.", kind: "work-type", weight: 2, color: "#8b6f9f", keywords: "ux ui design usability", provider: "" },
    { id: "area-backend", label: "Backend", description: "Server, database, and orchestration areas.", kind: "area", weight: 2, color: "#547446", keywords: "server backend database api", provider: "codex" },
    { id: "area-frontend", label: "Frontend", description: "Client-side views and interaction flows.", kind: "area", weight: 2, color: "#c79a3e", keywords: "frontend client view ui", provider: "claude" },
  ],
  providerPolicies: [],
};

export const POLICY_MODE_LABELS: Record<ProviderPolicyMode, string> = {
  "fill": "Fill",
  "throttle": "Throttle",
  "fallback-only": "Fallback only",
};

export const POLICY_MODE_DESCRIPTIONS: Record<ProviderPolicyMode, string> = {
  "fill": "Keep busy at all times. Ideal for time-windowed plans that reset frequently (e.g. hourly/daily).",
  "throttle": "Use for main work but preserve headroom. Set a headroom % to avoid exhausting the window.",
  "fallback-only": "Use only when no better option is available, or on explicit user request. Ideal for token-based / cost-per-request gateways.",
};

export const KIND_LABELS: Record<SegmentKind, string> = {
  "work-type": "Work type",
  provider: "Provider",
  area: "Area",
  custom: "Custom",
};

export function settingsKey(projectId: string) {
  return `board_strategy_${projectId}`;
}

export function presetsKey(projectId: string) {
  return `monitor_policy_presets_${projectId}`;
}

export interface MonitorPolicyPreset {
  id: string;
  name: string;
  activeAgentsTarget: number;
  backlogFloor: number;
  maxNewStartsPerCycle: number;
  refillFocus: "bugfix-only" | "balanced";
}

export const BUILTIN_PRESETS: MonitorPolicyPreset[] = [
  { id: "conservative", name: "Conservative", activeAgentsTarget: 2, backlogFloor: 15, maxNewStartsPerCycle: 1, refillFocus: "balanced" },
  { id: "balanced", name: "Balanced", activeAgentsTarget: 4, backlogFloor: 10, maxNewStartsPerCycle: 2, refillFocus: "balanced" },
  { id: "bug-bash", name: "Bug Bash", activeAgentsTarget: 6, backlogFloor: 8, maxNewStartsPerCycle: 3, refillFocus: "bugfix-only" },
];

export function clampWeight(value: number) {
  return Math.max(1, Math.min(5, Math.round(value || 1)));
}

export function clampPolicy(value: number, fallback: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(Number.isFinite(value) ? value : fallback)));
}

export function normalizeSegment(segment: Partial<StrategySegment>, index: number): StrategySegment {
  const fallback = DEFAULT_CONFIG.segments[index % DEFAULT_CONFIG.segments.length] ?? DEFAULT_CONFIG.segments[0];
  return {
    id: segment.id || `segment-${Date.now()}-${index}`,
    label: segment.label || fallback.label,
    description: segment.description ?? fallback.description,
    kind: segment.kind ?? fallback.kind,
    weight: clampWeight(segment.weight ?? fallback.weight),
    color: segment.color || fallback.color || BRAND,
    keywords: segment.keywords ?? fallback.keywords,
    provider: segment.provider ?? "",
  };
}

export function normalizeProviderPolicy(p: Partial<ProviderProfilePolicy>, index: number): ProviderProfilePolicy {
  const provider = (["claude", "codex", "copilot", "pi"].includes(p.provider ?? "") ? p.provider : "claude") as "claude" | "codex" | "copilot" | "pi";
  const profileName = typeof p.profileName === "string" ? p.profileName : "";
  const id = p.id || `policy-${provider}-${profileName || index}`;
  const validModes: ProviderPolicyMode[] = ["fill", "throttle", "fallback-only"];
  return {
    id,
    provider,
    profileName,
    label: typeof p.label === "string" && p.label.trim() ? p.label : `${provider}${profileName ? `:${profileName}` : ""}`,
    mode: (validModes.includes(p.mode as ProviderPolicyMode) ? p.mode : "throttle") as ProviderPolicyMode,
    headroomPct: clampPolicy(Number(p.headroomPct ?? 20), 20, 0, 100),
    notes: typeof p.notes === "string" ? p.notes : "",
    quotaProviderId: typeof p.quotaProviderId === "string" ? p.quotaProviderId : "",
  };
}

export function normalizeConfig(raw: unknown): StrategyConfig {
  const parsed = raw && typeof raw === "object" ? raw as Partial<StrategyConfig> : {};
  const segments = Array.isArray(parsed.segments)
    ? parsed.segments.map((segment, index) => normalizeSegment(segment, index)).filter((segment) => segment.label.trim())
    : DEFAULT_CONFIG.segments;
  const providerPolicies = Array.isArray(parsed.providerPolicies)
    ? parsed.providerPolicies.map((p, i) => normalizeProviderPolicy(p, i))
    : [];
  return {
    version: 1,
    activeAgentsTarget: clampPolicy(Number(parsed.activeAgentsTarget), DEFAULT_CONFIG.activeAgentsTarget, 1, 12),
    backlogFloor: clampPolicy(Number(parsed.backlogFloor), DEFAULT_CONFIG.backlogFloor, 0, 100),
    maxNewStartsPerCycle: clampPolicy(Number(parsed.maxNewStartsPerCycle), DEFAULT_CONFIG.maxNewStartsPerCycle, 1, 12),
    segments: segments.length > 0 ? segments : DEFAULT_CONFIG.segments,
    providerPolicies,
  };
}

export function normalizeToken(value: string) {
  return value.trim().toLowerCase();
}

export function segmentTokens(segment: StrategySegment) {
  return `${segment.label} ${segment.description} ${segment.keywords}`
    .split(/[\s,;#]+/)
    .map(normalizeToken)
    .filter((token) => token.length >= 3);
}

export function issueSearchText(issue: IssueWithStatus) {
  const tags = issue.tags?.map((tag) => tag.name).join(" ") ?? "";
  return `${issue.title} ${issue.description ?? ""} ${issue.issueType} ${issue.priority} ${issue.statusName} ${tags}`.toLowerCase();
}

export function matchesSegment(issue: IssueWithStatus, segment: StrategySegment) {
  const text = issueSearchText(issue);
  return segmentTokens(segment).some((token) => text.includes(token));
}

export function deriveRefillFocus(segments: StrategySegment[]) {
  const workSegments = segments.filter((segment) => segment.kind === "work-type");
  const bugfix = workSegments.filter((segment) => /bug|fix|defect|regression/i.test(`${segment.label} ${segment.keywords}`)).reduce((sum, segment) => sum + segment.weight, 0);
  const other = workSegments.filter((segment) => !/bug|fix|defect|regression/i.test(`${segment.label} ${segment.keywords}`)).reduce((sum, segment) => sum + segment.weight, 0);
  return bugfix > 0 && bugfix >= other ? "bugfix-only" : "balanced";
}

export function makeAgentBrief(config: StrategyConfig, issues: IssueWithStatus[]) {
  const top = [...config.segments].sort((a, b) => b.weight - a.weight).slice(0, 4);
  const policyLines = config.providerPolicies.length > 0
    ? [
        "",
        "Provider policies:",
        ...config.providerPolicies.map((p) => {
          const headroom = p.mode === "throttle" ? ` (headroom ${p.headroomPct}%)` : "";
          return `- ${p.label} [${p.provider}:${p.profileName}]: ${POLICY_MODE_LABELS[p.mode]}${headroom}${p.notes ? ` — ${p.notes}` : ""}`;
        }),
      ]
    : [];
  return [
    "Strategy Bullseye monitor policy:",
    `ACTIVE_AGENTS_TARGET=${config.activeAgentsTarget}, BACKLOG_FLOOR=${config.backlogFloor}, MAX_NEW_STARTS_PER_CYCLE=${config.maxNewStartsPerCycle}, REFILL_FOCUS=${deriveRefillFocus(config.segments)}.`,
    ...top.map((segment, index) => {
      const matches = issues.filter((issue) => matchesSegment(issue, segment)).length;
      const provider = segment.provider ? `, provider ${segment.provider}` : "";
      return `${index + 1}. ${segment.label} (${KIND_LABELS[segment.kind]}, weight ${segment.weight}/5${provider}): ${segment.description} Current matching tickets: ${matches}.`;
    }),
    ...policyLines,
  ].join("\n");
}

export function presetMatchesConfig(preset: MonitorPolicyPreset, config: StrategyConfig): boolean {
  return (
    preset.activeAgentsTarget === config.activeAgentsTarget &&
    preset.backlogFloor === config.backlogFloor &&
    preset.maxNewStartsPerCycle === config.maxNewStartsPerCycle &&
    preset.refillFocus === deriveRefillFocus(config.segments)
  );
}

/**
 * Derive the Strategy-Bullseye config persisted when migrating off the legacy
 * nudge_wip_limit pref: the clamped WIP limit becomes activeAgentsTarget (NaN →
 * 5). Intentionally minimal (no segments/providerPolicies) — matches the exact
 * shape the SettingsPanel migration used to build inline.
 */
export function buildMigrationConfig(wipLimitStr: string | undefined): {
  version: number;
  activeAgentsTarget: number;
  backlogFloor: number;
  maxNewStartsPerCycle: number;
  segments: StrategySegment[];
} {
  const wipLimit = parseInt(wipLimitStr || "5", 10);
  const activeAgentsTarget = Number.isFinite(wipLimit) ? wipLimit : 5;
  return { version: 1, activeAgentsTarget, backlogFloor: 3, maxNewStartsPerCycle: 3, segments: [] };
}
