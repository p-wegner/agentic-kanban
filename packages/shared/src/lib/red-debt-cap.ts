/**
 * The red-debt cap (#916) — "`sprint` with a ledger over N entries or older than T degrades
 * to `fast` automatically and says so, the shape of the profile-allowlist hold."
 *
 * Mirrors `profile-allowlist.ts`'s pure-policy shape deliberately: a parse step that can fail
 * closed, and a decision function returning a rich result (never a bare boolean) that a
 * caller MUST inspect before proceeding. Here there is no "hold" — a project may never refuse
 * to merge just because debt piled up — so exceeding the cap DEGRADES the posture instead of
 * blocking it, one step at a time (`sprint` -> `fast` -> `standard`), and the result always
 * carries a human-readable `note` so the degrade is never silent (the ticket's "refuse to
 * keep going quietly" framing, applied to a downgrade rather than a full stop).
 *
 * PURE and client-safe: no node builtins, so the posture chip can preview the same decision
 * the server will make.
 */
import { projectPref } from "./dynamic-preference-keys.js";

const redDebtMaxPrefDef = projectPref("red_debt_max");
const redDebtMaxAgePrefDef = projectPref("red_debt_max_age");

export function redDebtMaxPrefKey(projectId: string): string {
  return redDebtMaxPrefDef.key(projectId);
}

export function redDebtMaxAgePrefKey(projectId: string): string {
  return redDebtMaxAgePrefDef.key(projectId);
}

/** Default entry-count cap before a `sprint`/`fast` posture is forced to degrade. */
export const DEFAULT_RED_DEBT_MAX_ENTRIES = 10;
/** Default max age (ms) an OPEN entry may reach before it forces a degrade. Default: 14 days. */
export const DEFAULT_RED_DEBT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Parse a per-project numeric override, falling back to the default on anything unreadable
 *  (never negative, never zero — a cap of 0 would degrade on the FIRST entry, which reads as
 *  "the operator meant to disable the cap", not "meant to forbid all debt"). */
function parsePositiveInt(raw: string | null | undefined, fallback: number): number {
  const n = Number(raw);
  return raw != null && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export type RiskPostureLevel = "strict" | "standard" | "fast" | "sprint";

/** One degrade step, in order: sprint -> fast -> standard. `strict` never degrades further —
 *  there is nothing softer to fall back to, and strict never carries debt in the first place. */
const DEGRADE_STEP: Partial<Record<RiskPostureLevel, RiskPostureLevel>> = {
  sprint: "fast",
  fast: "standard",
};

export interface RedDebtCapInput {
  posture: RiskPostureLevel;
  /** Count of currently OPEN ledger entries for the project. */
  openEntryCount: number;
  /** Age (ms) of the OLDEST open entry, or null when there are none. */
  oldestOpenEntryAgeMs: number | null;
  /** Per-project `red_debt_max_<projectId>` pref, already read (raw string or null). */
  maxEntriesRaw?: string | null;
  /** Per-project `red_debt_max_age_<projectId>` pref, already read (raw string or null). */
  maxAgeMsRaw?: string | null;
}

export interface RedDebtCapResult {
  /** The posture to actually gate under. Equal to `input.posture` unless the cap forced a degrade. */
  effectivePosture: RiskPostureLevel;
  /** True when `effectivePosture !== input.posture`. */
  degraded: boolean;
  /** Human-readable reason, populated whenever `degraded` is true. Never silent. */
  note: string | null;
}

/**
 * Decide whether the debt cap forces a posture degrade.
 *
 * A project outside `sprint`/`fast` (i.e. `strict`/`standard`) is never evaluated — those
 * postures already run the full gate and carry no debt-driven softening to take away.
 */
export function resolveRedDebtCapDegrade(input: RedDebtCapInput): RedDebtCapResult {
  const { posture, openEntryCount, oldestOpenEntryAgeMs } = input;
  const noDegrade: RedDebtCapResult = { effectivePosture: posture, degraded: false, note: null };

  const nextStep = DEGRADE_STEP[posture];
  if (!nextStep) return noDegrade;

  const maxEntries = parsePositiveInt(input.maxEntriesRaw, DEFAULT_RED_DEBT_MAX_ENTRIES);
  const maxAgeMs = parsePositiveInt(input.maxAgeMsRaw, DEFAULT_RED_DEBT_MAX_AGE_MS);

  const overCount = openEntryCount > maxEntries;
  const overAge = oldestOpenEntryAgeMs !== null && oldestOpenEntryAgeMs > maxAgeMs;
  if (!overCount && !overAge) return noDegrade;

  const reasons: string[] = [];
  if (overCount) reasons.push(`${openEntryCount} open debt entries exceed the cap of ${maxEntries}`);
  if (overAge) reasons.push(`oldest open entry is ${Math.round((oldestOpenEntryAgeMs as number) / 60_000)}m old, exceeding the ${Math.round(maxAgeMs / 60_000)}m cap`);

  return {
    effectivePosture: nextStep,
    degraded: true,
    note: `red-debt cap exceeded (${reasons.join("; ")}) — posture degraded ${posture} -> ${nextStep}`,
  };
}

/**
 * Apply the degrade repeatedly until it stabilizes (a project that reopened debt after
 * already being at `fast` still only steps once per resolution, since `resolveRedDebtCapDegrade`
 * itself takes the CURRENT posture — this helper exists so a caller with one ledger snapshot
 * doesn't have to hand-loop the single-step function to reach the resting posture).
 */
export function resolveEffectiveRedDebtPosture(input: RedDebtCapInput): RedDebtCapResult {
  let current = resolveRedDebtCapDegrade(input);
  const notes: string[] = current.note ? [current.note] : [];
  // At most one further step exists today (sprint -> fast -> standard), so a bounded loop
  // is enough and can never spin: DEGRADE_STEP has no cycle.
  while (DEGRADE_STEP[current.effectivePosture]) {
    const next = resolveRedDebtCapDegrade({ ...input, posture: current.effectivePosture });
    if (!next.degraded) break;
    if (next.note) notes.push(next.note);
    current = { effectivePosture: next.effectivePosture, degraded: true, note: notes.join(" | ") };
  }
  return current;
}

const redDebtPosturePrefDef = projectPref("red_debt_posture");

export function redDebtPosturePrefKey(projectId: string): string {
  return redDebtPosturePrefDef.key(projectId);
}

const RISK_POSTURE_LEVELS: readonly RiskPostureLevel[] = ["strict", "standard", "fast", "sprint"];

export const RED_DEBT_POSTURE_DEFAULT: RiskPostureLevel = "standard";

/**
 * Resolve a project's posture from the `red_debt_posture_<projectId>` stand-in pref (#911 is
 * not landed yet — see `review-mode-pref.ts`'s identical stand-in for `review_mode`). Any
 * value other than an exact known level fails closed to `"standard"`, which never softens a
 * gate verdict — an unset/mistyped pref must never be read as an invitation to pass a red
 * suite through.
 */
export function resolveRedDebtGatePosture(value: string | null | undefined): RiskPostureLevel {
  return value && (RISK_POSTURE_LEVELS as readonly string[]).includes(value)
    ? (value as RiskPostureLevel)
    : RED_DEBT_POSTURE_DEFAULT;
}
