import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type StrategySegmentKind = "work-type" | "provider" | "area" | "custom";

export interface StrategyBullseyeSegment {
  id: string;
  label: string;
  kind?: StrategySegmentKind;
  weight?: number;
  provider?: "claude" | "codex" | "copilot" | "";
  keywords?: string;
}

/**
 * Rate-limit policy for a single provider profile.
 *
 * - "fill": use aggressively — keep busy at all times (e.g. time-windowed plans with cheap resets)
 * - "throttle": use for main work but preserve headroom (e.g. 5h/week plans shared with other projects)
 * - "fallback-only": only use when no better option exists, or on explicit user action (e.g. token-based gateways)
 *
 * `headroomPct` (0–100) is only meaningful for "throttle": the fraction of the window's capacity
 * the orchestrator should leave unused. E.g. 20 means "don't start new work if projected usage
 * would exceed 80% of the window".
 */
export type ProviderPolicyMode = "fill" | "throttle" | "fallback-only";

export interface ProviderProfilePolicy {
  /** Unique key: "{provider}:{profileName}" — e.g. "claude:work", "codex:default" */
  id: string;
  provider: "claude" | "codex" | "copilot";
  profileName: string;
  /** Human-readable label, e.g. "Claude (andrena gateway)" */
  label: string;
  mode: ProviderPolicyMode;
  /** 0–100. Only applies when mode="throttle". Leave this % of the rate-limit window unused. */
  headroomPct: number;
  /** Informational note shown in the UI and emitted into objective.md */
  notes: string;
}

export interface StrategyBullseyeConfig {
  version?: number;
  activeAgentsTarget?: number;
  backlogFloor?: number;
  maxNewStartsPerCycle?: number;
  segments?: StrategyBullseyeSegment[];
  /** Provider profile policies — controls how the orchestrator routes work to each profile. */
  providerPolicies?: ProviderProfilePolicy[];
}

export interface MonitorTunables {
  activeAgentsTarget: number;
  backlogFloor: number;
  maxNewStartsPerCycle: number;
  refillFocus: "bugfix-only" | "balanced";
}

const STRATEGY_RELATIVE_PATH = "scripts/board-monitor/objective.md";
const GENERATED_START = "<!-- STRATEGY_BULLSEYE_GENERATED_START -->";
const GENERATED_END = "<!-- STRATEGY_BULLSEYE_GENERATED_END -->";

const DEFAULT_TUNABLES: MonitorTunables = {
  activeAgentsTarget: 4,
  backlogFloor: 10,
  maxNewStartsPerCycle: 2,
  refillFocus: "balanced",
};

// Render-to-file is intentional: scripts/board-monitor/loop.sh and
// monitor-butler.ts already re-read objective.md each cycle, so updating this
// generated region gives both monitor mechanisms live policy changes without a
// restart or a second strategy source.
const WORK_TYPE_KEYWORDS = {
  bugfix: ["bug", "bugfix", "fix", "defect", "regression"],
  feature: ["feature", "enhancement", "product"],
  quality: ["quality", "reliability", "guardrail"],
  ux: ["ux", "ui", "design", "usability"],
  "tech-debt": ["tech debt", "technical debt", "debt", "refactor", "cleanup"],
  tests: ["test", "tests", "e2e", "unit"],
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function segmentWorkType(segment: StrategyBullseyeSegment): keyof typeof WORK_TYPE_KEYWORDS | "custom" {
  const text = `${segment.label} ${segment.keywords ?? ""}`.toLowerCase();
  for (const [type, tokens] of Object.entries(WORK_TYPE_KEYWORDS)) {
    if (tokens.some((token) => text.includes(token))) return type as keyof typeof WORK_TYPE_KEYWORDS;
  }
  return "custom";
}

function segmentWeight(segment: StrategyBullseyeSegment): number {
  return clampInt(segment.weight, 3, 1, 5);
}

const VALID_MODES: ProviderPolicyMode[] = ["fill", "throttle", "fallback-only"];

function parseProviderPolicies(raw: unknown): ProviderProfilePolicy[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p === "object" && typeof p.id === "string" && typeof p.provider === "string")
    .map((p) => ({
      id: p.id as string,
      provider: (["claude", "codex", "copilot"].includes(p.provider) ? p.provider : "claude") as "claude" | "codex" | "copilot",
      profileName: typeof p.profileName === "string" ? p.profileName : "",
      label: typeof p.label === "string" ? p.label : p.id as string,
      mode: (VALID_MODES.includes(p.mode) ? p.mode : "throttle") as ProviderPolicyMode,
      headroomPct: clampInt(p.headroomPct, 20, 0, 100),
      notes: typeof p.notes === "string" ? p.notes : "",
    }));
}

export function parseStrategyBullseyeConfig(raw: string): StrategyBullseyeConfig {
  if (!raw.trim()) return { version: 1, segments: [] };
  const parsed = JSON.parse(raw) as StrategyBullseyeConfig;
  if (!parsed || typeof parsed !== "object") return { version: 1, segments: [] };
  return {
    version: parsed.version,
    activeAgentsTarget: parsed.activeAgentsTarget,
    backlogFloor: parsed.backlogFloor,
    maxNewStartsPerCycle: parsed.maxNewStartsPerCycle,
    segments: Array.isArray(parsed.segments)
      ? parsed.segments
          .filter((segment) => segment && typeof segment.id === "string" && typeof segment.label === "string")
          .map((segment) => ({
            id: segment.id,
            label: segment.label,
            kind: segment.kind,
            weight: segment.weight,
            provider: segment.provider,
            keywords: segment.keywords,
          }))
      : [],
    providerPolicies: parseProviderPolicies(parsed.providerPolicies),
  };
}

export function deriveMonitorTunables(config: StrategyBullseyeConfig): MonitorTunables {
  const segments = config.segments ?? [];
  let bugfixWeight = 0;
  let nonBugfixWorkWeight = 0;

  for (const segment of segments) {
    if (segment.kind && segment.kind !== "work-type") continue;
    const type = segmentWorkType(segment);
    if (type === "bugfix") bugfixWeight += segmentWeight(segment);
    else if (type !== "custom") nonBugfixWorkWeight += segmentWeight(segment);
  }

  return {
    activeAgentsTarget: clampInt(config.activeAgentsTarget, DEFAULT_TUNABLES.activeAgentsTarget, 1, 12),
    backlogFloor: clampInt(config.backlogFloor, DEFAULT_TUNABLES.backlogFloor, 0, 100),
    maxNewStartsPerCycle: clampInt(config.maxNewStartsPerCycle, DEFAULT_TUNABLES.maxNewStartsPerCycle, 1, 12),
    refillFocus: bugfixWeight > 0 && bugfixWeight >= nonBugfixWorkWeight ? "bugfix-only" : "balanced",
  };
}

const MODE_DESCRIPTIONS: Record<ProviderPolicyMode, string> = {
  "fill": "FILL — use aggressively, keep busy at all times",
  "throttle": "THROTTLE — use for main work but preserve headroom",
  "fallback-only": "FALLBACK-ONLY — use only when no better option exists or on explicit user request",
};

export function renderGeneratedStrategyBlock(config: StrategyBullseyeConfig): string {
  const tunables = deriveMonitorTunables(config);
  const segments = [...(config.segments ?? [])].sort((a, b) => segmentWeight(b) - segmentWeight(a));
  const weightedLines = segments.length === 0
    ? ["- No bullseye markers configured yet."]
    : segments.map((segment) => {
        const kind = segment.kind ?? "custom";
        const provider = segment.provider ? `, provider ${segment.provider}` : "";
        return `- ${segment.label}: weight ${segmentWeight(segment)}/5, ${kind}${provider}`;
      });

  const policies = config.providerPolicies ?? [];
  const policyLines = policies.length === 0
    ? ["- No provider policies configured. Workspace launches use the globally-selected provider."]
    : policies.map((p) => {
        const headroom = p.mode === "throttle" ? `, headroom ${p.headroomPct}%` : "";
        const notes = p.notes ? ` (${p.notes})` : "";
        return `- **${p.label}** [${p.provider}:${p.profileName}]: ${MODE_DESCRIPTIONS[p.mode]}${headroom}${notes}`;
      });

  const providerStrategyNote = policies.length > 0 ? [
    "",
    "## PROVIDER POLICY (generated - do not hand-edit)",
    "When selecting a provider for a new workspace, apply these rules in priority order:",
    "1. **FILL** profiles should always have capacity — start work on them first.",
    "2. **THROTTLE** profiles are preferred for main work. Respect their headroom percentage.",
    "3. **FALLBACK-ONLY** profiles are last resort — only use if all others are exhausted or the user explicitly selects them.",
    ...policyLines,
  ] : [];

  return [
    "## TUNABLE TARGETS - generated from Strategy Bullseye",
    GENERATED_START,
    "> The loop re-reads this file at the START of every iteration, so changes here take effect on the next cycle with **NO restart**. This block is generated from the Strategy Bullseye preference; edit the bullseye in the board UI instead of hand-editing these values.",
    `- **ACTIVE_AGENTS_TARGET = ${tunables.activeAgentsTarget}** - keep this many workspaces actively In Progress at all times.`,
    `- **BACKLOG_FLOOR = ${tunables.backlogFloor}** - never let the backlog drop below this; refill before it does.`,
    `- **MAX_NEW_STARTS_PER_CYCLE = ${tunables.maxNewStartsPerCycle}** - cap on how many NEW workspaces to launch in a single cycle.`,
    `- **REFILL_FOCUS = ${tunables.refillFocus}** - derived from work-type marker weights; \`bugfix-only\` emphasizes reproducible bugs, \`balanced\` allows feature/quality mix.`,
    "",
    "## STRATEGY WEIGHTS (generated - do not hand-edit)",
    ...weightedLines,
    ...providerStrategyNote,
    GENERATED_END,
  ].join("\n");
}

export function updateObjectiveWithStrategy(objectiveText: string, config: StrategyBullseyeConfig): string {
  const block = renderGeneratedStrategyBlock(config);
  const generatedPattern = new RegExp(`${GENERATED_START}[\\s\\S]*?${GENERATED_END}`);
  if (generatedPattern.test(objectiveText)) {
    return objectiveText.replace(/## TUNABLE TARGETS[^\n]*\n[\s\S]*?<!-- STRATEGY_BULLSEYE_GENERATED_END -->/, block);
  }

  const tunablesHeading = objectiveText.match(/^## TUNABLE TARGETS[^\n]*$/m);
  if (tunablesHeading?.index !== undefined) {
    const start = tunablesHeading.index;
    const afterHeading = start + tunablesHeading[0].length;
    const firstMarker = objectiveText.indexOf("\nFIRST,", afterHeading);
    const eachRunMarker = objectiveText.indexOf("\nEach run,", afterHeading);
    const nextIndex = firstMarker >= 0 ? firstMarker : eachRunMarker;
    if (nextIndex >= 0) {
      return `${objectiveText.slice(0, start)}${block}\n${objectiveText.slice(nextIndex + 1)}`;
    }
  }

  return `${objectiveText.trimEnd()}\n\n${block}\n`;
}

export function writeStrategyObjective(repoPath: string, rawConfig: string): void {
  const config = parseStrategyBullseyeConfig(rawConfig);
  const objectivePath = join(repoPath, STRATEGY_RELATIVE_PATH);
  if (!existsSync(objectivePath)) return;
  const current = readFileSync(objectivePath, "utf8");
  const next = updateObjectiveWithStrategy(current, config);
  if (next !== current) {
    writeFileSync(objectivePath, next, "utf8");
  }
}

export function isBoardStrategyKey(key: string): boolean {
  return /^board_strategy_[0-9a-f-]+$/.test(normalizeText(key));
}

export function projectIdFromBoardStrategyKey(key: string): string | null {
  const match = normalizeText(key).match(/^board_strategy_([0-9a-f-]+)$/);
  return match?.[1] ?? null;
}

/**
 * Select the best provider+profile for a new workspace based on the strategy config.
 *
 * Priority order:
 * 1. "fill" profiles — always keep busy, use first
 * 2. "throttle" profiles — preferred for main work
 * 3. "fallback-only" profiles — last resort
 *
 * Returns `null` if no policies are configured (caller should use the globally-selected provider).
 * Returns the policy with the highest priority that is not "fallback-only" by default;
 * "fallback-only" profiles are only returned if `allowFallback` is true and there are no
 * other options.
 */
export function selectProviderFromStrategy(
  config: StrategyBullseyeConfig,
  options: { allowFallback?: boolean } = {},
): { provider: "claude" | "codex" | "copilot"; profileName: string; policy: ProviderProfilePolicy } | null {
  const policies = config.providerPolicies ?? [];
  if (policies.length === 0) return null;

  const fill = policies.filter((p) => p.mode === "fill");
  if (fill.length > 0) {
    return { provider: fill[0].provider, profileName: fill[0].profileName, policy: fill[0] };
  }

  const throttle = policies.filter((p) => p.mode === "throttle");
  if (throttle.length > 0) {
    return { provider: throttle[0].provider, profileName: throttle[0].profileName, policy: throttle[0] };
  }

  if (options.allowFallback) {
    const fallback = policies.filter((p) => p.mode === "fallback-only");
    if (fallback.length > 0) {
      return { provider: fallback[0].provider, profileName: fallback[0].profileName, policy: fallback[0] };
    }
  }

  return null;
}
