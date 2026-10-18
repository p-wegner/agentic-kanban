import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import caps from "@agentic-kanban/shared/lib/code-health-caps.json";

/**
 * Code-health posture (#1613, decision 021): soft and hard caps per metric.
 *
 * A SOFT breach never blocks anything — it is recorded in the ledger and shown in the console.
 * A HARD breach blocks, but only where the author still has the context (the builder's
 * pre-commit hook and implement-exit check); the train gate only re-checks hard caps. When the
 * soft breaches accumulate past the level's trigger, ONE consolidated cleanup ticket is filed
 * (and later breaches APPEND to it until it starts).
 *
 * The numbers live in shared/lib `code-health-caps.json` so `scripts/check-god-modules.mjs` (plain Node)
 * reads the same table as the TypeScript consumers. This module is the pure logic: no I/O.
 */

export const CODE_HEALTH_LEVELS = ["strict", "balanced", "relaxed"] as const;
export type CodeHealthLevel = (typeof CODE_HEALTH_LEVELS)[number];

export const CODE_HEALTH_METRICS = ["lines", "branches", "declarations"] as const;
export type CodeHealthMetric = (typeof CODE_HEALTH_METRICS)[number];

export interface MetricCaps {
  soft: number;
  hard: number;
}

export interface CleanupTrigger {
  /** Open soft breaches that make a cleanup ticket due. */
  breaches: number;
  /** Age in days of the oldest open soft breach that makes it due; null = age never triggers. */
  days: number | null;
}

export interface CodeHealthCaps extends Record<CodeHealthMetric, MetricCaps> {
  cleanupTrigger: CleanupTrigger;
}

export const codeHealthPosturePref = projectPref("code_health_posture");
export const codeHealthLedgerPref = projectPref("code_health_ledger");

const LEVELS = caps.levels as Record<CodeHealthLevel, CodeHealthCaps>;
export const CODE_HEALTH_GATE_DEFAULT_LEVEL = caps.gateDefaultLevel as CodeHealthLevel;

export function isCodeHealthLevel(value: unknown): value is CodeHealthLevel {
  return typeof value === "string" && (CODE_HEALTH_LEVELS as readonly string[]).includes(value);
}

export function capsForLevel(level: CodeHealthLevel): CodeHealthCaps {
  return LEVELS[level];
}

export interface ResolvedCodeHealthPosture {
  level: CodeHealthLevel;
  /** `override` = `code_health_posture_<id>` was set; `risk-posture` = derived from the risk level. */
  source: "override" | "risk-posture";
  caps: CodeHealthCaps;
}

/**
 * The effective code-health posture: the per-project override when it parses, otherwise derived
 * from the risk posture level. An unparseable override falls back to the derived default.
 */
export function resolveCodeHealthPosture(
  riskLevel: string,
  override?: string | null,
): ResolvedCodeHealthPosture {
  if (isCodeHealthLevel(override)) {
    return { level: override, source: "override", caps: capsForLevel(override) };
  }
  const derived = (caps.defaultByRiskPosture as Record<string, string>)[riskLevel];
  const level = isCodeHealthLevel(derived) ? derived : "balanced";
  return { level, source: "risk-posture", caps: capsForLevel(level) };
}

export type CapVerdict = "ok" | "soft" | "hard";

/**
 * Classify one measurement. `grandfatheredAt` is the ratchet-baseline value (COMPLEXITY_BASELINE /
 * COHESION_BASELINE): it raises the HARD cap for that file to its baseline, so a legacy offender
 * is only blocked when it grows past where it was grandfathered.
 */
export function classifyMetric(
  metric: CodeHealthMetric,
  value: number,
  levelCaps: CodeHealthCaps,
  grandfatheredAt?: number,
): CapVerdict {
  const hard = Math.max(levelCaps[metric].hard, grandfatheredAt ?? 0);
  if (value > hard) return "hard";
  if (value > levelCaps[metric].soft) return "soft";
  return "ok";
}

export interface SoftBreach {
  file: string;
  metric: CodeHealthMetric;
  value: number;
  cap: number;
  /** Function name for the branches metric. */
  detail?: string;
}

export interface LedgerEntry extends SoftBreach {
  firstSeen: string;
  /** The commit or ticket that crossed the cap (as reported by the recorder). */
  crossedBy: string | null;
}

const entryKey = (e: { file: string; metric: string }) => `${e.file}\u0000${e.metric}`;

/**
 * Fold the current scan into the ledger: an entry that is still breaching keeps its `firstSeen`
 * and `crossedBy` (value/cap refreshed), a new breach is stamped with `now`/`ref`, and an entry
 * that no longer breaches is dropped — the ledger is the OPEN set.
 */
export function reconcileLedger(
  previous: readonly LedgerEntry[],
  current: readonly SoftBreach[],
  opts: { now?: string; ref?: string | null } = {},
): LedgerEntry[] {
  const now = opts.now ?? new Date().toISOString();
  const known = new Map(previous.map((e) => [entryKey(e), e]));
  return current.map((b) => {
    const prior = known.get(entryKey(b));
    return {
      ...b,
      firstSeen: prior?.firstSeen ?? now,
      crossedBy: prior ? prior.crossedBy : opts.ref ?? null,
    };
  });
}

export interface CleanupDecision {
  due: boolean;
  reason: string;
  breaches: number;
  files: number;
}

export function evaluateCleanupTrigger(
  ledger: readonly LedgerEntry[],
  levelCaps: CodeHealthCaps,
  nowMs: number,
): CleanupDecision {
  const files = new Set(ledger.map((e) => e.file)).size;
  const trigger = levelCaps.cleanupTrigger;
  if (ledger.length === 0) return { due: false, reason: "no open soft breaches", breaches: 0, files };
  if (ledger.length >= trigger.breaches) {
    return { due: true, reason: `${ledger.length} open soft breaches (trigger: ${trigger.breaches})`, breaches: ledger.length, files };
  }
  if (trigger.days !== null) {
    const oldest = Math.min(...ledger.map((e) => Date.parse(e.firstSeen)));
    const ageDays = (nowMs - oldest) / 86_400_000;
    if (ageDays >= trigger.days) {
      return { due: true, reason: `oldest soft breach is ${Math.floor(ageDays)} days old (trigger: ${trigger.days})`, breaches: ledger.length, files };
    }
  }
  return { due: false, reason: `${ledger.length} of ${trigger.breaches} breaches`, breaches: ledger.length, files };
}

/** `code health: 7 soft breaches in 4 files, cleanup ticket at 10 (relaxed)` */
export function formatCodeHealthLine(ledger: readonly LedgerEntry[], level: CodeHealthLevel): string {
  const files = new Set(ledger.map((e) => e.file)).size;
  const n = ledger.length;
  const trigger = capsForLevel(level).cleanupTrigger;
  return `code health: ${n} soft breach${n === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"}, `
    + `cleanup ticket at ${trigger.breaches} (${level})`;
}

export interface CleanupTicketState {
  issueId: string;
  issueNumber: number | null;
  /** True once the ticket left the not-yet-started columns; breaches then wait for the next ticket. */
  started: boolean;
}

export type CleanupAction = "none" | "file" | "append" | "hold";

/**
 * One open cleanup ticket at a time: due + no ticket -> `file`; an unstarted ticket + breaches
 * -> `append`; a started ticket -> `hold` (new breaches accumulate for the NEXT ticket);
 * not due and no ticket -> `none`.
 */
export function planCleanupAction(
  decision: CleanupDecision,
  ticket: CleanupTicketState | null,
): CleanupAction {
  if (ticket) {
    if (ticket.started) return "hold";
    return decision.breaches > 0 ? "append" : "none";
  }
  return decision.due ? "file" : "none";
}

export interface CodeHealthLedgerState {
  entries: LedgerEntry[];
}

export function parseLedgerState(raw: string | null | undefined): CodeHealthLedgerState {
  if (!raw) return { entries: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<CodeHealthLedgerState>;
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}

export function cleanupTicketTitle(): string {
  return "code health: decompose files and functions over their soft caps";
}

export function cleanupTicketBody(ledger: readonly LedgerEntry[], level: CodeHealthLevel): string {
  const lines = [
    `The code-health ledger crossed its cleanup trigger (${formatCodeHealthLine(ledger, level)}).`,
    ``,
    `Acceptance: every listed file / function ends BELOW its soft cap (not merely under the hard cap; trimming comments or blank lines does not count). Decompose along real seams, behind their existing import paths (facade barrel). Moving a branchy function to another file does not clear it. This ticket runs alone, not in a train with feature work.`,
    ``,
    `| File | Metric | Value | Soft cap | First seen | Crossed by |`,
    `|---|---|---|---|---|---|`,
    ...ledger.map((e) =>
      `| \`${e.file}\` | ${e.metric}${e.detail ? ` (${e.detail})` : ""} | ${e.value} | ${e.cap} | ${e.firstSeen.slice(0, 10)} | ${e.crossedBy ?? "-"} |`),
  ];
  return lines.join("\n");
}
