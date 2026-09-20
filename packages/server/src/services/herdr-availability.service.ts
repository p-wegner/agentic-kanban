import { probeHerdr } from "@agentic-kanban/shared/lib/herdr-exec";

/**
 * Config discovery for herdr (ticket #1144 of the herdr-support epic, #1129).
 *
 * herdr (see `~/.claude/notes-core/guides/herdr.md`, or `docs/decisions/` once a
 * decision record exists for it) is a terminal multiplexer whose background
 * server hosts long-lived panes that survive a terminal window closing. It is
 * deliberately NOT wired as a `PROVIDER_NAMES` entry alongside claude/codex/
 * copilot/pi: it does not itself run a coding agent the way those CLIs do, it
 * hosts one — closer in shape to the devcontainer/worker-fleet PLACEMENT
 * concerns than to a fifth agent harness. Making it a `ProviderName` would force
 * every exhaustive provider switch (`provider-exit-behavior.ts`,
 * `provider-pair-parity.test.ts`, the client optgroups, …) to answer for a
 * concept — "which model/CLI is this?" — that herdr has no opinion on.
 *
 * This module is the discovery half only: is a `herdr` binary reachable on this
 * machine, and what version. The result is a support signal for Settings/UI and
 * for a later launch-wrap (mirroring `agent-provider/container-wrap.ts`'s
 * "pure transform between buildLaunchConfig() and spawn()" shape) — it does not
 * itself launch anything.
 *
 * Cached with a short TTL: this shells out, and callers (a settings-panel health
 * check, a preflight) may poll it far more often than the answer can change on a
 * running machine.
 */

export interface HerdrAvailability {
  available: boolean;
  version?: string;
  /** True when `version` carries a `-fork.<n>` marker (see the herdr guide's fork section). */
  isFork: boolean;
  checkedAt: number;
}

const CACHE_TTL_MS = 30_000;

let cached: HerdrAvailability | undefined;

export function isForkVersion(version: string | undefined): boolean {
  return !!version && /-fork\./i.test(version);
}

/**
 * Probe herdr availability, caching the result for {@link CACHE_TTL_MS}. Never
 * throws — a missing/broken `herdr` binary resolves to `{available: false}`.
 *
 * `probe` is injectable (defaults to the real `probeHerdr`) so tests exercise
 * the caching/shaping logic without shelling out.
 */
export async function getHerdrAvailability(
  nowMs: number = Date.now(),
  probe: () => Promise<{ available: boolean; version?: string }> = probeHerdr,
): Promise<HerdrAvailability> {
  if (cached && nowMs - cached.checkedAt < CACHE_TTL_MS) return cached;

  const result = await probe();
  cached = {
    available: result.available,
    version: result.version,
    isFork: isForkVersion(result.version),
    checkedAt: nowMs,
  };
  return cached;
}

/** Test-only: force the next {@link getHerdrAvailability} call to re-probe. */
export function resetHerdrAvailabilityCache(): void {
  cached = undefined;
}
