import { execFile } from "node:child_process";
import * as os from "node:os";

/**
 * Host-capacity signal for the server's placement decisions (#908).
 *
 * Nothing in the server read RAM/CPU/swap before this: `agent.service.ts` spawns a
 * ~520 MB `claude.exe` unconditionally, and the only capacity-aware code in the repo was
 * the Claude-hook heuristic `.claude/hooks/machine-capacity.js`, which runs client-side
 * per turn and never informed a placement decision. This module is that same heuristic,
 * ported so the SERVER can use it, plus an optional richer answer from the `claude-pick`
 * fleet tool when it happens to be installed.
 *
 * Two tiers, cheapest first:
 * - **Tier 0** (`readTier0Capacity`): one in-process `os.freemem()` read, no spawn. Always
 *   available, always cheap enough to call on every monitor cycle or even per turn.
 * - **Tier 1** (`readTier1Capacity`): shells out to `fleet snapshot --json` (the
 *   `claude-pick` CLI) once per monitor cycle for a sharper answer —
 *   `verdict.canStartAnother`, `system.headroomProcesses` (how many more whole `claude.exe`
 *   processes the box can take), `system.memory.thrashing`. `fleet` is a SIBLING tool, not
 *   a dependency: when it is not on PATH, or its output cannot be parsed, Tier 1 degrades
 *   to Tier 0 and says so via `tier: "0"` on the returned snapshot — never throws, never
 *   blocks a caller that only wanted a best-effort answer.
 *
 * `resolveMachineCapacity` is the one entry point callers should use — it tries Tier 1
 * and falls back to Tier 0 transparently.
 *
 * Node-only (imports `node:os` / `node:child_process`): must never be a VALUE export from
 * the `@agentic-kanban/shared/lib` barrel (white-screens the client bundle, #791). Re-export
 * as `export type *` only; import the runtime via the deep path
 * `@agentic-kanban/shared/lib/machine-capacity`. Mirrors `docker-exec.ts` / `git-exec.ts`.
 */

const GB = 2 ** 30;

/** Default floor, in GB of `os.freemem()`. Override with `SMART_HOOKS_MIN_FREE_GB`. */
export const DEFAULT_MIN_FREE_GB = 2;

export interface Tier0Capacity {
  tier: "0";
  /** True when the box is too tight to add another agent process right now. */
  hold: boolean;
  /** One line naming the measurement and, when holding, why. */
  reason: string;
  freeGb: number | null;
}

/**
 * Zero-spawn capacity read: `os.freemem()` against the documented 2 GB floor.
 *
 * Ported from `capacityHold()` in `.claude/hooks/machine-capacity.js` — same floor, same
 * force/override env vars, same fail-open behaviour on an unreadable `os.freemem()`. Kept
 * as a straight port rather than a rewrite so the hook and the server never quietly
 * diverge on what "tight" means.
 *
 * Why `os.freemem()` and not a load average: `os.loadavg()` returns `[0,0,0]` on Windows,
 * so it carries no signal there. `freemem` is optimistic — it counts standby cache the OS
 * can reclaim, so it reads higher than a fleet tool's "usable" figure. The 2 GB default is
 * calibrated against that skew, not against the fleet number: 2 GB of freemem corresponds
 * to roughly "under a gigabyte truly free".
 */
export function readTier0Capacity(opts: { minFreeGb?: number } = {}): Tier0Capacity {
  if (process.env.SMART_HOOKS_FORCE === "1") {
    return { tier: "0", hold: false, reason: "SMART_HOOKS_FORCE=1", freeGb: null };
  }

  const floor = Number(opts.minFreeGb ?? process.env.SMART_HOOKS_MIN_FREE_GB ?? DEFAULT_MIN_FREE_GB);
  // A malformed override must not silently disable the guard OR silently block every
  // check — fall back to the default rather than trusting NaN.
  const effectiveFloor = Number.isFinite(floor) && floor >= 0 ? floor : DEFAULT_MIN_FREE_GB;

  let freeGb: number;
  try {
    freeGb = os.freemem() / GB;
  } catch {
    // Cannot read memory: fail OPEN. The guard is an optimization; a broken guard must
    // not disable placement.
    return { tier: "0", hold: false, reason: "freemem unreadable", freeGb: null };
  }

  if (freeGb >= effectiveFloor) {
    return { tier: "0", hold: false, reason: `${freeGb.toFixed(1)}GB free`, freeGb };
  }
  return {
    tier: "0",
    hold: true,
    freeGb,
    reason: `only ${freeGb.toFixed(1)}GB free (floor ${effectiveFloor}GB)`,
  };
}

export interface Tier1Capacity {
  tier: "1";
  canStartAnother: boolean;
  /** How many more whole agent processes the box can take, per the fleet tool. */
  headroomProcesses: number;
  thrashing: "none" | "light" | "heavy" | string;
}

/** Default kill timeout for the `fleet snapshot` spawn (ms). */
const FLEET_SNAPSHOT_TIMEOUT_MS = 5000;

interface FleetSnapshotJson {
  verdict?: { canStartAnother?: boolean };
  system?: { headroomProcesses?: number; memory?: { thrashing?: string } };
}

function parseFleetSnapshot(stdout: string): Tier1Capacity | null {
  let parsed: FleetSnapshotJson;
  try {
    parsed = JSON.parse(stdout) as FleetSnapshotJson;
  } catch {
    return null;
  }
  const headroomProcesses = parsed.system?.headroomProcesses;
  const canStartAnother = parsed.verdict?.canStartAnother;
  if (typeof headroomProcesses !== "number" || typeof canStartAnother !== "boolean") return null;
  return {
    tier: "1",
    canStartAnother,
    headroomProcesses,
    thrashing: parsed.system?.memory?.thrashing ?? "none",
  };
}

/**
 * One spawn of `fleet snapshot --json` (the `claude-pick` CLI). Returns `null` when the
 * tool is absent, times out, or its output cannot be parsed into the shape this module
 * expects — every one of those is "no Tier 1 answer", never a thrown error, so a caller
 * can unconditionally fall back to Tier 0.
 */
export function readTier1Capacity(opts: { timeoutMs?: number } = {}): Promise<Tier1Capacity | null> {
  return new Promise((resolve) => {
    execFile(
      "fleet",
      ["snapshot", "--json"],
      { timeout: opts.timeoutMs ?? FLEET_SNAPSHOT_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        resolve(parseFleetSnapshot(stdout.toString()));
      },
    );
  });
}

export type MachineCapacitySnapshot =
  | (Tier1Capacity & { hold: boolean })
  | (Tier0Capacity & { hold: boolean });

/**
 * The worker-heartbeat shape (#910): free RAM GB, spare cores, a thrashing flag — same
 * fields Tier 0/1 already carry, folded into one snapshot a worker daemon can drop
 * straight onto its heartbeat. `spareCores` has no existing Tier 0/1 concept, so it is
 * computed here from `os.cpus().length`; a caller with a real load figure (e.g. Tier 1's
 * `fleet` tool) can override `usedCores` to get a sharper answer, cheaper than the
 * `headroomProcesses` figure. Never throws: an unreadable `os.cpus()` degrades to 0
 * spare cores rather than failing the whole snapshot.
 */
export interface WorkerCapacitySnapshot {
  freeRamGb: number;
  spareCores: number;
  thrashing: "none" | "light" | "heavy" | string;
}

export function resolveSpareCores(opts: { usedCores?: number } = {}): number {
  let total: number;
  try {
    total = os.cpus().length;
  } catch {
    return 0;
  }
  const used = opts.usedCores ?? 0;
  return Math.max(0, total - used);
}

/**
 * Fold a `MachineCapacitySnapshot` into the worker-heartbeat capacity shape. Tier 0 has
 * no thrashing signal of its own (RAM-only), so it reports `"none"` — that is honestly
 * "not measured", not a claim the machine is calm; a caller wanting the sharper answer
 * should install the `fleet` CLI so Tier 1 fires instead.
 */
export function toWorkerCapacitySnapshot(
  snapshot: MachineCapacitySnapshot,
  opts: { usedCores?: number } = {},
): WorkerCapacitySnapshot {
  const freeRamGb = snapshot.tier === "1" ? Math.max(0, os.freemem() / GB) : (snapshot.freeGb ?? 0);
  return {
    freeRamGb,
    spareCores: resolveSpareCores(opts),
    thrashing: snapshot.tier === "1" ? snapshot.thrashing : "none",
  };
}

/**
 * The one entry point callers should use: try Tier 1, degrade to Tier 0 when the fleet
 * tool is absent or unusable. `hold` is normalized across tiers so a caller never has to
 * branch on `tier` to answer "can I start another agent on this host right now" — but the
 * tier is still on the result, because the monitor status should say WHICH tier answered
 * (#908) rather than presenting a Tier-0 guess as the sharper Tier-1 measurement.
 */
export async function resolveMachineCapacity(opts: {
  minFreeGb?: number;
  fleetTimeoutMs?: number;
} = {}): Promise<MachineCapacitySnapshot> {
  const tier1 = await readTier1Capacity({ timeoutMs: opts.fleetTimeoutMs });
  if (tier1) return { ...tier1, hold: !tier1.canStartAnother };
  const tier0 = readTier0Capacity({ minFreeGb: opts.minFreeGb });
  return { ...tier0, hold: tier0.hold };
}

/**
 * Derive a verify-gate worker/semaphore width from live capacity instead of a hand-set
 * constant (#909). `KANBAN_VERIFY_CONCURRENCY` was fixed at 2 and `verify_max_workers_<id>`
 * was documented as "a statement about THIS box's core count" — i.e. a human doing this
 * arithmetic by hand, once, and never again. Measured: 2380s -> 1564s at 6 workers on an
 * idle box; the same 6 flakes on a loaded one, so the number that helps on one run is the
 * number that hurts on the next.
 *
 * `ceiling` is the per-project pref (still 1..32, still meaningful — an operator who knows
 * the box gets the last word) and the result never exceeds it. Callers layer an env-var
 * override ON TOP of this (checked first, before ever calling in), exactly like every other
 * semaphore in this codebase (`KANBAN_VERIFY_CONCURRENCY`, `KANBAN_VERIFY_CHAIN_CONCURRENCY`).
 *
 * The formula favors CPU (each vitest fork wants a core) and then clamps to what free RAM
 * can actually hold, since a fork that swaps is slower than one fork that doesn't. `~300MB`
 * per fork is a conservative estimate for a Node/vitest worker; a floor of 1 is always
 * returned so a tight box still makes progress, just serialized.
 */
export interface DeriveVerifyWorkersInput {
  /** Logical CPU count, e.g. `os.cpus().length`. */
  cpuCount: number;
  /** Free RAM in GB, e.g. from {@link Tier0Capacity.freeGb} or Tier 1's headroom. */
  freeGb: number | null;
  /** The per-project pref (already clamped 1..32) — a hard CEILING, never exceeded. */
  ceiling: number;
}

/** RAM budget per vitest fork, in GB — conservative (a Node worker + its own module graph). */
const RAM_PER_WORKER_GB = 0.3;

export function deriveVerifyWorkers(input: DeriveVerifyWorkersInput): number {
  const cpuBudget = Math.max(1, input.cpuCount - 2);
  const ramBudget = input.freeGb == null ? cpuBudget : Math.max(1, Math.floor(input.freeGb / RAM_PER_WORKER_GB));
  const derived = Math.min(cpuBudget, ramBudget);
  return Math.max(1, Math.min(derived, input.ceiling));
}
