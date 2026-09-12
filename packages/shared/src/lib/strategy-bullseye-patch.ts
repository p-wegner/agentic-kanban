/**
 * Patch the Strategy Bullseye's NUMERIC targets without touching anything else in it (#1102).
 *
 * Since #1102 the Bullseye is the ONE home of a project's WIP (`activeAgentsTarget`) and its
 * per-cycle start cap (`maxNewStartsPerCycle`). Three writers now set those two numbers without
 * opening the full Strategy Targets editor: the startup migration that retires
 * `wip_limit_<projectId>`, the onboarding wizard's WIP step, and the toolbar Autopilot chip.
 *
 * All three must PRESERVE the rest of the blob — segments, provider policies, the harness share,
 * and any field this module has never heard of. The client's `normalizeConfig` REBUILDS the
 * object it saves, which is exactly how the provider policies' `model` was lost in #983; a chip
 * stepper that went through it would also inject the editor's default segments into a project
 * that never had any. So this works on the raw JSON object: parse, overwrite the named keys,
 * serialize.
 *
 * Pure and client-safe (no Node builtins, no schema) — the client imports it by deep path.
 */

export interface BullseyeTargetPatch {
  activeAgentsTarget?: number;
  maxNewStartsPerCycle?: number;
  backlogFloor?: number;
}

export type PatchBullseyeResult =
  /** `created` is true when there was no Bullseye and this call minted one. */
  | { ok: true; value: string; created: boolean }
  /** The stored value is not a JSON object; it is left alone rather than overwritten. */
  | { ok: false; reason: "malformed" };

function asInt(value: number | undefined, min: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n >= min ? n : undefined;
}

function cleanPatch(patch: BullseyeTargetPatch): BullseyeTargetPatch {
  const out: BullseyeTargetPatch = {};
  const agents = asInt(patch.activeAgentsTarget, 1);
  const starts = asInt(patch.maxNewStartsPerCycle, 1);
  const floor = asInt(patch.backlogFloor, 0);
  if (agents !== undefined) out.activeAgentsTarget = agents;
  if (starts !== undefined) out.maxNewStartsPerCycle = starts;
  if (floor !== undefined) out.backlogFloor = floor;
  return out;
}

/**
 * Parse a stored Bullseye into a plain object, `null` when absent/blank, or `"malformed"`.
 * Deliberately distinguishes absent from corrupt: a writer may mint a Bullseye where there is
 * none, but must never replace a corrupt one it cannot read (that would delete whatever the
 * operator had there).
 */
export function parseBullseyeObject(raw: string | null | undefined): Record<string, unknown> | null | "malformed" {
  if (raw === null || raw === undefined || !raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : "malformed";
  } catch {
    return "malformed";
  }
}

/** The Bullseye's own positive `activeAgentsTarget`, or null when it names none. */
export function bullseyeActiveAgentsTarget(raw: string | null | undefined): number | null {
  const obj = parseBullseyeObject(raw);
  if (obj === null || obj === "malformed") return null;
  const value = obj.activeAgentsTarget;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/**
 * Overwrite `patch`'s keys in the stored Bullseye, keeping every other field.
 *
 * When there is no Bullseye yet, one is minted from `seed` + `patch`. `seed` exists so a caller
 * can carry over the numbers the monitor is ALREADY running at: creating a Bullseye flips
 * `resolveMonitorTunables` from its legacy path (backlog floor 3, 3 starts per cycle) to the
 * Bullseye's defaults (10 and 2), so a bare `{ activeAgentsTarget }` would silently change two
 * numbers nobody asked to change.
 */
export function patchStrategyBullseyeJson(
  raw: string | null | undefined,
  patch: BullseyeTargetPatch,
  seed: BullseyeTargetPatch = {},
): PatchBullseyeResult {
  const obj = parseBullseyeObject(raw);
  if (obj === "malformed") return { ok: false, reason: "malformed" };
  const cleaned = cleanPatch(patch);
  if (obj === null) {
    return { ok: true, created: true, value: JSON.stringify({ version: 1, ...cleanPatch(seed), ...cleaned, segments: [] }) };
  }
  return { ok: true, created: false, value: JSON.stringify({ ...obj, ...cleaned }) };
}
