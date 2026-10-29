import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import type { RedBasePolicy } from "@agentic-kanban/shared/types";
import type { Database } from "../db/index.js";
import { getAllPreferencesCached, getPreference } from "../repositories/preferences.repository.js";
import { listRedDebt } from "../repositories/red-debt.repository.js";
import {
  redDebtMaxAgePrefKey,
  redDebtMaxPrefKey,
  resolveEffectiveRedBasePolicy,
  type RedBasePolicyCapResult,
} from "../lib/red-debt-cap.js";
import { resolveRiskPosture, type RiskPosture } from "./risk-posture.service.js";

export interface EffectiveRedBasePolicy {
  /** The posture the policy was derived from (level + softer-only override, before the cap). */
  posture: RiskPosture;
  /** The policy to ACT on: `posture.redBasePolicy` after the #916 red-debt cap. */
  policy: RedBasePolicy;
  cap: RedBasePolicyCapResult;
  /** The open red-debt ledger the cap was evaluated against (one snapshot, reusable by the subset rule). */
  ledger: Awaited<ReturnType<typeof listRedDebt>>;
  /** Cap note when the cap degraded the policy, else null — fold into any posture summary (visibility rule). */
  capNote: string | null;
}

/**
 * The ONE DB-reading resolver of the EFFECTIVE red-base policy (#1740): the posture's
 * `redBasePolicy` with the #916 red-debt cap applied over the project's open ledger. The
 * sequential merge gate, the #915 subset rule, the train window's red-base veto and the
 * delivery chip all read it, so the cap holds for trains as well as singleton merges.
 *
 * `posture` is optional so a caller that already resolved one does not pay a second read.
 */
export async function resolveEffectiveRedBasePolicyFor(
  projectId: string,
  database: Database,
  opts: { posture?: RiskPosture } = {},
): Promise<EffectiveRedBasePolicy> {
  const posture = opts.posture ?? resolveRiskPosture(
    toPrefMap(await getAllPreferencesCached(database).catch(() => [])),
    projectId,
  );
  const ledger = await listRedDebt(projectId, {}, database);
  const openedAt = ledger.map((e) => Date.parse(e.openedAt)).filter((n) => !Number.isNaN(n));
  const oldestOpenEntryAgeMs = openedAt.length > 0 ? Date.now() - Math.min(...openedAt) : null;
  const [maxEntriesRaw, maxAgeMsRaw] = await Promise.all([
    getPreference(redDebtMaxPrefKey(projectId), database).catch(() => null),
    getPreference(redDebtMaxAgePrefKey(projectId), database).catch(() => null),
  ]);
  const cap = resolveEffectiveRedBasePolicy({
    policy: posture.redBasePolicy,
    openEntryCount: ledger.length,
    oldestOpenEntryAgeMs,
    maxEntriesRaw,
    maxAgeMsRaw,
  });
  return { posture, policy: cap.effectivePolicy, cap, ledger, capNote: cap.degraded ? cap.note : null };
}
