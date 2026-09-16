import { resolveExecutable } from "../agent-cli-version.service.js";

/**
 * Availability gate for the Herdr provider (#1144).
 *
 * Herdr is a terminal multiplexer for coding agents, not a hosted service every
 * machine has — unlike claude/codex/copilot/pi it must never be OFFERED as a
 * selectable provider on a machine that doesn't have it wired up. The gate is
 * intentionally two-part:
 *
 *   1. the `herdr` binary resolves on PATH (mirrors `agent-cli-version.service`'s
 *      own executable resolution, so this checks the SAME binary a launch would use)
 *   2. `HERDR_ENV=1` is set OR a Herdr server is reachable — the same "is this
 *      session actually inside/near a Herdr pane" signal the vendor `herdr` skill
 *      checks before touching its CLI (see notes-core/guides/herdr.md).
 *
 * Both must hold. A binary with no reachable server is a stale/uninstalled Herdr;
 * a reachable server with no binary means nothing on THIS machine can drive it.
 */

export interface HerdrAvailability {
  available: boolean;
  /** True when `herdr` resolves to an executable on PATH. */
  binaryFound: boolean;
  /** Resolved path to the binary, if found. */
  binaryPath: string | null;
  /** True when HERDR_ENV=1 is set in the environment (inside/spawned-from a pane). */
  envFlagSet: boolean;
  /** True when a Herdr server responded to a reachability probe. */
  serverReachable: boolean;
  /** Human-readable reason the provider is/isn't available, for diagnostics/UI. */
  reason: string;
}

export type HerdrServerProbe = () => Promise<boolean>;

/** Default server probe: env-only — no network probe is attempted at import time.
 *  A caller wanting a live reachability check passes its own `probe` (see
 *  `detectHerdrAvailabilityLive` below), keeping this module import-time-safe and
 *  side-effect-free (no accidental network calls just from being imported). */
const alwaysUnreachable: HerdrServerProbe = () => Promise.resolve(false);

/**
 * Synchronous half of the gate: binary-on-PATH + HERDR_ENV. Safe to call from any
 * request path (no I/O beyond a PATH scan, mirroring `resolveExecutable`).
 */
export function detectHerdrAvailability(
  env: NodeJS.ProcessEnv = process.env,
  command = "herdr",
): HerdrAvailability {
  const binaryPath = resolveExecutable(command);
  const binaryFound = !!binaryPath;
  const envFlagSet = env.HERDR_ENV === "1" || env.HERDR_ENV === "true";
  const serverReachable = false; // synchronous gate never probes the network
  const available = binaryFound && envFlagSet;
  const reason = available
    ? "herdr binary on PATH and HERDR_ENV set"
    : !binaryFound
      ? "herdr binary not found on PATH"
      : "HERDR_ENV is not set (not running inside/near a Herdr pane)";
  return { available, binaryFound, binaryPath, envFlagSet, serverReachable, reason };
}

/**
 * Full gate: binary-on-PATH plus (HERDR_ENV OR a reachable server). Widens the
 * synchronous gate's env-only check with an actual reachability probe, for callers
 * that can afford the I/O (e.g. Settings panel load, profile-health listing) —
 * this is what lets Herdr be offered from a session that was launched by Herdr but
 * doesn't itself carry HERDR_ENV (e.g. a server-side probe from another process).
 */
export async function detectHerdrAvailabilityLive(
  probe: HerdrServerProbe = alwaysUnreachable,
  env: NodeJS.ProcessEnv = process.env,
  command = "herdr",
): Promise<HerdrAvailability> {
  const base = detectHerdrAvailability(env, command);
  if (base.envFlagSet || !base.binaryFound) return base;

  let serverReachable = false;
  try {
    serverReachable = await probe();
  } catch {
    serverReachable = false;
  }

  const available = base.binaryFound && serverReachable;
  const reason = available
    ? "herdr binary on PATH and a Herdr server is reachable"
    : "herdr binary found but no HERDR_ENV and no reachable Herdr server";
  return { ...base, serverReachable, available, reason };
}
