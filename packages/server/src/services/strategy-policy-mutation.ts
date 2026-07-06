import type { ProviderProfilePolicy } from "./strategy-objective.service.js";

/**
 * Surgical mutations of STORED Strategy Bullseye JSON blobs (`board_strategy_*`
 * preference values). Lives next to the strategy-objective module so the
 * knowledge of the `providerPolicies[].provider/profileName` shape stays with
 * the Bullseye schema instead of being duplicated by callers (#986 — the
 * auth-rotation ring previously raw-parsed and duck-typed the blob itself).
 */

/**
 * Retarget a stored Bullseye JSON blob: every `providerPolicies[]` entry for
 * `provider` whose `profileName` is `fromProfile` is repointed at `toProfile`.
 * Raw-parse + re-serialize (NOT parse→normalize→emit) so unknown / extra fields
 * in the stored blob survive the rewrite.
 *
 * Returns the updated JSON string, or `null` when nothing changed (unparseable
 * blob, no providerPolicies array, or no matching policy) — callers skip the
 * write in that case.
 */
export function retargetProviderPolicyProfile(
  raw: string,
  provider: ProviderProfilePolicy["provider"],
  fromProfile: string,
  toProfile: string,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const policies = (parsed as Record<string, unknown>).providerPolicies;
  if (!Array.isArray(policies)) return null;
  let changed = false;
  for (const policy of policies) {
    if (!policy || typeof policy !== "object") continue;
    const rec = policy as Record<string, unknown>;
    if (rec.provider === provider && rec.profileName === fromProfile) {
      rec.profileName = toProfile;
      changed = true;
    }
  }
  return changed ? JSON.stringify(parsed) : null;
}
