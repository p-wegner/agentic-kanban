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

export interface StrategyBullseyeConfig {
  version?: number;
  activeAgentsTarget?: number;
  backlogFloor?: number;
  maxNewStartsPerCycle?: number;
  segments?: StrategyBullseyeSegment[];
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
