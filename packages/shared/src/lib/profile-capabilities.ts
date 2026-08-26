/**
 * Data-handling capability tags for provider profiles (#876).
 *
 * A worker MACHINE already declares generic capabilities via `--labels` (docker, linux,
 * ...) and a project can REQUIRE a subset of them (`worker_labels_<projectId>`,
 * `worker-protocol.ts` / `worker-fleet.service.ts`). That mechanism has no equivalent for
 * the PROFILE (the auth/config selection a session actually launches under) — and a
 * profile is where a data-handling property like "this account's provider does not train
 * on submitted data" or "this account is EU-hosted" actually lives, not the machine.
 *
 * This module is the profile-side counterpart, deliberately mirroring
 * `profile-allowlist.ts`'s shape (same `AllowedProfile`-style pair, same
 * `provider:name` compact id, same tri-state parse result) so the two preference
 * families read the same way to an operator and to a future caller.
 *
 * PURE and client-safe: no node builtins, so the Settings UI can preview the same
 * decision the server will make.
 */
import type { AgentProviderName } from "./provider-traits.js";
import { narrowProvider } from "./provider-traits.js";
import { projectPref } from "./dynamic-preference-keys.js";

/**
 * The preference key one profile's capability tags live under:
 * `profile_capabilities_<provider>:<profileName>`. A FREEFORM suffix (registered in
 * `FREEFORM_SUFFIX_KEY_PREFIXES`, same shape as `claude_cooldown_<profile>` in
 * `profile-allowlist.ts`'s `profileCooldownKey`), not a per-project key — capability
 * tags describe the profile itself, independent of which project is asking.
 */
export function profileCapabilitiesPrefKey(provider: AgentProviderName | string, profileName: string): string {
  return `profile_capabilities_${narrowProvider(provider)}:${profileName}`;
}

const requiredDataLabelsPrefDef = projectPref("required_data_labels");

/**
 * The per-project required-tags key: `required_data_labels_<projectId>`, a CSV a
 * project's launches must find on whichever profile they resolve to (e.g.
 * "no-training,eu-data-residency"). Absent/empty = unrestricted.
 */
export function requiredDataLabelsPrefKey(projectId: string): string {
  return requiredDataLabelsPrefDef.key(projectId);
}

/** Parse the stored `required_data_labels_<projectId>` value: a CSV of required tags. */
export function parseRequiredDataLabels(raw: string | null | undefined): string[] {
  return parseProfileCapabilities(raw);
}

/**
 * Well-known data-handling tags. Not an exhaustive/closed vocabulary — a project may
 * require any free-text tag — but these are the two the ticket named, spelled once so
 * "no-training" vs "NO_TRAINING" vs "no_training" is not reinvented at every call site.
 */
export const NO_TRAINING_LABEL = "no-training";
export const EU_DATA_RESIDENCY_LABEL = "eu-data-residency";

export const WELL_KNOWN_DATA_HANDLING_LABELS = [NO_TRAINING_LABEL, EU_DATA_RESIDENCY_LABEL] as const;

function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

/** Parse the stored `profile_capabilities_<provider:profile>` value: a CSV of free-text tags. */
export function parseProfileCapabilities(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((t) => normalizeTag(t))
    .filter(Boolean);
}

/** Serialize back to the canonical stored CSV form, deduped. */
export function serializeProfileCapabilities(tags: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const norm = normalizeTag(t);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out.join(",");
}

/** True when a profile carrying `tags` (already parsed) satisfies every one of `required`. */
export function profileSatisfiesRequiredTags(tags: string[], required: string[]): boolean {
  if (required.length === 0) return true;
  const have = new Set(tags.map(normalizeTag));
  return required.every((r) => have.has(normalizeTag(r)));
}

/**
 * Which of `required` are missing from `tags`. Empty means satisfied — used to build an
 * operator-facing message the same way `worker-fleet.service.ts` reports missing labels.
 */
export function missingProfileTags(tags: string[], required: string[]): string[] {
  const have = new Set(tags.map(normalizeTag));
  return required.filter((r) => !have.has(normalizeTag(r)));
}

/**
 * May a launch under `{provider, profileName}` proceed for a project requiring
 * `requiredRaw` (the project's `required_data_labels_<projectId>` value)?
 *
 * Mirrors `remoteDispatchBlockedByAllowlist`'s shape (same `{blocked}` tri-state), but
 * this is a plain membership check, not a fallback/clamp: a data-handling requirement
 * names a PROPERTY the resolved profile must have, and there is no "pick a different one
 * that also qualifies" — that choice belongs to whoever configures the profile pool
 * (the allowlist), not to this check.
 *
 * `profileName` absent (no profile resolved yet, e.g. the mock agent) is treated as
 * carrying no tags — blocked whenever the project requires any, since an untagged
 * profile cannot be assumed compliant.
 */
export function dataHandlingBlockedByRequirement(input: {
  requiredRaw: string | null | undefined;
  provider: string | null | undefined;
  profileName: string | null | undefined;
  profileTagsRaw: string | null | undefined;
}): { blocked: false } | { blocked: true; reason: string; missing: string[] } {
  const required = parseRequiredDataLabels(input.requiredRaw);
  if (required.length === 0) return { blocked: false };
  const tags = parseProfileCapabilities(input.profileTagsRaw);
  const missing = missingProfileTags(tags, required);
  if (missing.length === 0) return { blocked: false };
  const who = input.profileName
    ? `profile ${narrowProvider(input.provider)}:${input.profileName}`
    : "the resolved profile";
  return {
    blocked: true,
    reason: `${who} is missing required data-handling tag(s) [${missing.join(", ")}]`,
    missing,
  };
}

/**
 * #876 — may this project's work be dispatched to a FLEET WORKER at all, when the project
 * requires data-handling tags (`required_data_labels_<projectId>`)?
 *
 * Mirrors `remoteDispatchBlockedByAllowlist` in `profile-allowlist.ts` exactly, and for the
 * same reason: a fleet worker authenticates the agent with its OWN local login (decision
 * 012 — the board sends no credentials), so the board can require a profile carry
 * `no-training`/`eu-data-residency` but has no way to confirm the worker's machine actually
 * launches under a profile carrying those tags. The constraint therefore does not travel
 * with the dispatch, so — same as the allowlist — a restricted project must not go remote
 * rather than silently losing the guarantee.
 *
 * This is deliberately not the last word: worker-side ATTESTATION (a worker declaring which
 * profile tags it can honour, the way it already declares `--providers`/`--labels`) would
 * let a restricted project dispatch to a worker that proves it qualifies. That check would
 * go right here, narrowing the block instead of replacing it — see
 * `remoteDispatchBlockedByAllowlist`'s own doc comment, which anticipates the same fix for
 * the allowlist case.
 */
export function remoteDispatchBlockedByDataHandling(
  requiredRaw: string | null | undefined,
): { blocked: false } | { blocked: true; reason: string; required: string[] } {
  const required = parseRequiredDataLabels(requiredRaw);
  if (required.length === 0) return { blocked: false };
  return {
    blocked: true,
    reason:
      `it requires data-handling tag(s) [${required.join(", ")}], and a fleet worker authenticates ` +
      "with its own machine-local login (the board sends no credentials), so the requirement cannot be enforced there",
    required,
  };
}
