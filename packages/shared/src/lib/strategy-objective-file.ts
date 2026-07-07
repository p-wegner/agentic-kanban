/**
 * Strategy Bullseye → objective.md rendering + file write (node-only).
 *
 * SINGLE SOURCE OF TRUTH (#arch-review §3.3): these helpers used to live only in
 * the server's `strategy-objective.service.ts`, so the MCP `set_preference` tool
 * had no way to regenerate `objective.md` and silently skipped it — leaving the
 * Conductor (objective.md reader) and the in-process monitor (pref reader) on
 * different tunables. They now live here so BOTH the server preference service and
 * the MCP checked-write path drive the exact same rendering.
 *
 * Node-only (fs + git-exec). It must NOT be re-exported as a VALUE through the
 * client barrel (`lib/index.ts`) — Vite would pull `node:fs`/`git-exec` into the
 * browser bundle and white-screen the UI (see shared/CLAUDE.md #791). Reach it via
 * the deep path `@agentic-kanban/shared/lib/strategy-objective-file`.
 */
import { gitExecSync } from "./git-exec.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROVIDER_POLICY_MODES,
  PROVIDER_POLICY_PROVIDERS,
} from "./strategy-policy.js";
import type { ProviderPolicyMode, ProviderProfilePolicy } from "./strategy-policy.js";
import { isBoardStrategyPreferenceKey } from "./dynamic-preference-keys.js";

export type StrategySegmentKind = "work-type" | "provider" | "area" | "custom";

export interface StrategyBullseyeSegment {
  id: string;
  label: string;
  kind?: StrategySegmentKind;
  weight?: number;
  provider?: "claude" | "codex" | "copilot" | "pi" | "";
  keywords?: string;
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
export const PROJECT_CONDUCTOR_OBJECTIVE_RELATIVE_PATH = ".kanban/objective.md";
export const PROJECT_CONDUCTOR_STATE_RELATIVE_DIR = ".kanban/conductor";
const GENERATED_START = "<!-- STRATEGY_BULLSEYE_GENERATED_START -->";
const GENERATED_END = "<!-- STRATEGY_BULLSEYE_GENERATED_END -->";

const DEFAULT_TUNABLES: MonitorTunables = {
  activeAgentsTarget: 4,
  backlogFloor: 10,
  maxNewStartsPerCycle: 2,
  refillFocus: "balanced",
};

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

const VALID_MODES: readonly ProviderPolicyMode[] = PROVIDER_POLICY_MODES;

/** Untrusted shape of a single provider policy entry before validation. */
interface RawProviderPolicy {
  id: string;
  provider: string;
  profileName?: unknown;
  label?: unknown;
  mode?: unknown;
  headroomPct?: unknown;
  notes?: unknown;
  quotaProviderId?: unknown;
  model?: unknown;
}

function isRawProviderPolicy(p: unknown): p is RawProviderPolicy {
  if (!p || typeof p !== "object") return false;
  const candidate = p as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.provider === "string";
}

function parseProviderPolicies(raw: unknown): ProviderProfilePolicy[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter(isRawProviderPolicy)
    .map((p) => ({
      id: p.id,
      provider: ((PROVIDER_POLICY_PROVIDERS as readonly string[]).includes(p.provider) ? p.provider : "claude") as "claude" | "codex" | "copilot" | "pi",
      profileName: typeof p.profileName === "string" ? p.profileName : "",
      label: typeof p.label === "string" ? p.label : p.id,
      mode: (typeof p.mode === "string" && VALID_MODES.includes(p.mode as ProviderPolicyMode) ? p.mode : "throttle") as ProviderPolicyMode,
      headroomPct: clampInt(p.headroomPct, 20, 0, 100),
      notes: typeof p.notes === "string" ? p.notes : "",
      quotaProviderId: typeof p.quotaProviderId === "string" && p.quotaProviderId.trim() ? p.quotaProviderId.trim() : undefined,
      model: typeof p.model === "string" && p.model.trim() ? p.model.trim() : undefined,
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
        const quotaId = p.quotaProviderId ? `, quota-id: ${p.quotaProviderId}` : "";
        const notes = p.notes ? ` (${p.notes})` : "";
        return `- **${p.label}** [${p.provider}:${p.profileName}]: ${MODE_DESCRIPTIONS[p.mode]}${headroom}${quotaId}${notes}`;
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

export function renderProjectConductorObjective(project: { id: string; name?: string | null; repoPath: string; defaultBranch?: string | null }): string {
  return [
    `# Project Conductor Objective - ${project.name || project.id}`,
    "",
    `You are the out-of-process Conductor for board project \`${project.id}\`. Drive only this project.`,
    "",
    "## Project",
    `- Project ID: \`${project.id}\``,
    project.name ? `- Project name: \`${project.name}\`` : null,
    `- Repo path: \`${project.repoPath}\``,
    project.defaultBranch ? `- Default branch: \`${project.defaultBranch}\`` : null,
    "",
    "## Operating Rules",
    "- Read the board state for this project before acting.",
    "- Merge, unstick, nudge, start, and refill only this project's tickets and workspaces.",
    "- Do not change global provider settings; use this project's Strategy Bullseye provider policy for new launches.",
    "- Prefer board MCP tools, then the board CLI or API when MCP is unavailable.",
    "- Keep changes bounded to board orchestration; do not implement product code unless a ticket workspace agent is explicitly launched for it.",
    "- Append one concise cycle summary to `.kanban/conductor/state.md` before exiting.",
    "",
    "## TUNABLE TARGETS - generated from Strategy Bullseye",
    GENERATED_START,
    "> This block is replaced whenever the Strategy Bullseye preference is saved.",
    "- **ACTIVE_AGENTS_TARGET = 4** - keep this many workspaces actively In Progress at all times.",
    "- **BACKLOG_FLOOR = 10** - never let the backlog drop below this; refill before it does.",
    "- **MAX_NEW_STARTS_PER_CYCLE = 2** - cap on how many NEW workspaces to launch in a single cycle.",
    "- **REFILL_FOCUS = balanced** - derived from work-type marker weights.",
    "",
    "## STRATEGY WEIGHTS (generated - do not hand-edit)",
    "- No bullseye markers configured yet.",
    GENERATED_END,
  ].filter((line): line is string => line !== null).join("\n");
}

/**
 * Render the Strategy Bullseye into the repo's `objective.md` generated block.
 * Returns `true` if the file existed and was actually rewritten (content changed),
 * so callers can decide whether a follow-up auto-commit is warranted.
 *
 * NB: `objective.md` exists ONLY in the agentic-kanban repo (the Conductor's
 * hand-authored, agentic-kanban-only control plane — see docs/decisions/006,
 * "Driven projects"). For every *driven* project there is no objective.md, so this
 * returns `false` and writes nothing: the Strategy Bullseye still takes effect for
 * those projects through `resolveMonitorTunables`, which reads the
 * `board_strategy_<projectId>` preference directly. This no-op is the mechanism that
 * lets a non-agentic-kanban project drive hands-off with no objective.md (#802).
 */
export function writeStrategyObjective(
  repoPath: string,
  rawConfig: string,
  options: { objectiveRelativePath?: string; createIfMissing?: boolean; project?: { id: string; name?: string | null; repoPath: string; defaultBranch?: string | null } } = {},
): boolean {
  const config = parseStrategyBullseyeConfig(rawConfig);
  const objectiveRelativePath = options.objectiveRelativePath ?? STRATEGY_RELATIVE_PATH;
  const objectivePath = join(repoPath, objectiveRelativePath);
  if (!existsSync(objectivePath)) {
    if (!options.createIfMissing || !options.project) return false;
    mkdirSync(join(repoPath, ".kanban"), { recursive: true });
    writeFileSync(objectivePath, renderProjectConductorObjective(options.project), "utf8");
  }
  const current = readFileSync(objectivePath, "utf8");
  const next = updateObjectiveWithStrategy(current, config);
  if (next !== current) {
    writeFileSync(objectivePath, next, "utf8");
    return true;
  }
  return false;
}

/**
 * Commit ONLY `objective.md` (path-scoped, so it never sweeps unrelated staged or
 * working-tree changes). A Strategy Bullseye save regenerates this git-tracked file;
 * leaving it uncommitted dirties the main checkout and blocks the board's auto-merge
 * queue. Best-effort: any failure (not a git repo, git hook rejects, file gitignored)
 * is swallowed so a preference save never fails because of git. No-op when the file
 * has no uncommitted changes.
 */
export function commitObjectiveFile(repoPath: string): boolean {
  const objectivePath = join(repoPath, STRATEGY_RELATIVE_PATH);
  if (!existsSync(objectivePath)) return false;
  try {
    const status = gitExecSync(["status", "--porcelain", "--", STRATEGY_RELATIVE_PATH], { cwd: repoPath }).trim();
    if (!status) return false;
    gitExecSync(
      ["commit", "-m", "chore(monitor): sync objective.md from Strategy Bullseye save", "--", STRATEGY_RELATIVE_PATH],
      { cwd: repoPath },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the effective monitor tunables for a project, used by the deterministic
 * in-process monitor (mechanism 2: `runAutoStart` / `runBacklogEmptyStrategy`).
 *
 * Priority:
 * 1. If a `board_strategy_<projectId>` preference exists, derive the tunables from
 *    the Strategy Bullseye — the SAME values the external loop and Monitor Butler
 *    read out of `objective.md`. This is what wires the strategic targets into the
 *    shipped in-process monitor.
 * 2. Otherwise fall back to the legacy `nudge_*` prefs so projects that never opened
 *    the Strategy Bullseye keep their exact prior behavior.
 *
 * `source` lets callers log/telemetry which control surface actually drove a cycle.
 */
export function resolveMonitorTunables(
  prefMap: Map<string, string>,
  projectId: string,
): { tunables: MonitorTunables; source: "strategy" | "prefs" } {
  const raw = prefMap.get(`board_strategy_${projectId}`);
  if (raw) {
    try {
      return { tunables: deriveMonitorTunables(parseStrategyBullseyeConfig(raw)), source: "strategy" };
    } catch {
      /* malformed strategy JSON — fall through to legacy prefs */
    }
  }
  const wipLimit = parseInt(prefMap.get("nudge_wip_limit") || "5", 10);
  return {
    tunables: {
      activeAgentsTarget: Number.isFinite(wipLimit) ? wipLimit : 5,
      // Floor of 3 (was 1) keeps a small backlog buffer for projects with no Strategy
      // Bullseye. maxNewStartsPerCycle capped at 3 (was Infinity): without a cap, a
      // per-project hands-off (board_autodrive) project with many Todo tickets would
      // launch them ALL in one cycle into conflicting worktrees. Staggering across
      // cycles lets earlier work land before the next batch starts. (#532)
      backlogFloor: 3,
      maxNewStartsPerCycle: 3,
      refillFocus: "balanced",
    },
    source: "prefs",
  };
}

export function isBoardStrategyKey(key: string): boolean {
  // Delegates to the shared pure predicate (also enforced by MCP set_preference, #989).
  return isBoardStrategyPreferenceKey(key);
}

export function projectIdFromBoardStrategyKey(key: string): string | null {
  const match = normalizeText(key).match(/^board_strategy_([0-9a-f-]+)$/);
  return match?.[1] ?? null;
}
