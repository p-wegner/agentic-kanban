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
 * Lives in `server/lib` and not `shared/lib`. Only the red-base-POLICY form remains (#1740
 * deleted the posture-LEVEL form: no production caller, and a level table that knew neither
 * `iterate` nor `flow`); its DB-reading consumer is `services/red-base-policy.service.ts`.
 *
 * PURE: no node builtins, so the posture chip can preview the same decision
 * the server will make.
 */
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import type { RedBasePolicy } from "@agentic-kanban/shared/types";

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

/** Is the ledger over either cap, and why? `null` = within both caps. Shared by the posture
 *  form above and the red-base-policy form below, so the two can never disagree about when
 *  the cap bites. */
function capExceededReasons(input: {
  openEntryCount: number;
  oldestOpenEntryAgeMs: number | null;
  maxEntriesRaw?: string | null;
  maxAgeMsRaw?: string | null;
}): string[] | null {
  const { openEntryCount, oldestOpenEntryAgeMs } = input;
  const maxEntries = parsePositiveInt(input.maxEntriesRaw, DEFAULT_RED_DEBT_MAX_ENTRIES);
  const maxAgeMs = parsePositiveInt(input.maxAgeMsRaw, DEFAULT_RED_DEBT_MAX_AGE_MS);

  const overCount = openEntryCount > maxEntries;
  const overAge = oldestOpenEntryAgeMs !== null && oldestOpenEntryAgeMs > maxAgeMs;
  if (!overCount && !overAge) return null;

  const reasons: string[] = [];
  if (overCount) reasons.push(`${openEntryCount} open debt entries exceed the cap of ${maxEntries}`);
  if (overAge) reasons.push(`oldest open entry is ${Math.round((oldestOpenEntryAgeMs as number) / 60_000)}m old, exceeding the ${Math.round(maxAgeMs / 60_000)}m cap`);
  return reasons;
}

/** One degrade step for the RED-BASE POLICY, in the same direction the softer-only override
 *  is allowed to move (#1015): report -> allow-file-debt-ticket -> allow-known-debt -> block.
 *  `report` (#1233) is in the chain on purpose — a policy the cap could not reach would be the
 *  #916 hole again (a project softening verdicts forever with a ledger nobody drains). */
const POLICY_DEGRADE_STEP: Partial<Record<RedBasePolicy, RedBasePolicy>> = {
  report: "allow-file-debt-ticket",
  "allow-file-debt-ticket": "allow-known-debt",
  "allow-known-debt": "block",
};

export interface RedBasePolicyCapInput {
  /** The policy the posture resolved (level table + any softer project override). */
  policy: RedBasePolicy;
  /** Count of currently OPEN ledger entries for the project. */
  openEntryCount: number;
  /** Age (ms) of the OLDEST open entry, or null when there are none. */
  oldestOpenEntryAgeMs: number | null;
  maxEntriesRaw?: string | null;
  maxAgeMsRaw?: string | null;
}

export interface RedBasePolicyCapResult {
  effectivePolicy: RedBasePolicy;
  degraded: boolean;
  /** Human-readable reason, populated whenever `degraded` is true. Never silent. */
  note: string | null;
}

/**
 * The #916 cap expressed on the RED-BASE POLICY rather than the posture LEVEL (#1015).
 *
 * The merge gate's subset rule now keys on `redBasePolicy`, and a project may reach a soft
 * policy WITHOUT a soft level (an `iterate` project carrying the softer-only project override). Capping
 * the level alone would therefore have left that project softening verdicts forever — the
 * exact hole #916 was written to close. So the cap runs on the policy: over cap, the policy
 * steps all the way down to `block`, because the cap condition does not change as it steps
 * (unlike a level, no intermediate policy is "small enough debt" again).
 *
 * Within cap, or already `block`, this is a no-op — so a project nobody configured is
 * byte-identical to before.
 */
export function resolveEffectiveRedBasePolicy(input: RedBasePolicyCapInput): RedBasePolicyCapResult {
  const noDegrade: RedBasePolicyCapResult = { effectivePolicy: input.policy, degraded: false, note: null };
  if (!POLICY_DEGRADE_STEP[input.policy]) return noDegrade;

  const reasons = capExceededReasons(input);
  if (!reasons) return noDegrade;

  const notes: string[] = [];
  let current = input.policy;
  for (let next = POLICY_DEGRADE_STEP[current]; next; next = POLICY_DEGRADE_STEP[current]) {
    notes.push(`red-debt cap exceeded (${reasons.join("; ")}) — red-base policy degraded ${current} -> ${next}`);
    current = next;
  }
  return { effectivePolicy: current, degraded: true, note: notes.join(" | ") };
}
