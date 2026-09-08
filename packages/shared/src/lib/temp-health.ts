import { opendirSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * Is `%TEMP%` in a state a verify chain can survive? (#1056)
 *
 * The pre-merge gate died four times across three branches (#1046, #1048, #1049 x2) with
 * **exit 1 and no test output at all** — vitest killed during setup, the captured log ending
 * mid-banner. It was diagnosed as machine load, then as log truncation, then as the board's
 * own resource sweeper, before the measurement that explained it: `%TEMP%` held **707,242
 * entries**, at which size a bare directory enumeration exceeded a 120-second timeout doing
 * nothing but listing names. Every process that touches `%TEMP%` stalls, and a test runner
 * touches it constantly. ~113 minutes of gate time went into three wrong diagnoses.
 *
 * Disk space was never the issue (208 GB free), which is why no size alarm anywhere saw it.
 *
 * **The probe measures the enumeration RATE, not the total size** — and that is the whole
 * design, because counting the directory is the very operation that stalls. Reading the true
 * total on the measured machine cost 12.7s for 100,324 entries; a gate preflight that pays
 * that is itself part of the problem. So the walk stops at whichever comes first:
 *
 * - `maxEntries` names seen — the directory is at least that big, which is the answer; or
 * - `budgetMs` elapsed — enumeration is too slow to finish, which is the SAME answer arrived
 *   at from the other side, and is exactly the pathological state at 707k.
 *
 * Either way the probe costs at most `budgetMs`, never the full walk. A run that finishes
 * inside both bounds has proven the directory is small AND fast, which is all the gate needs.
 *
 * Fail-open by construction, like `readTier0Capacity` (#1009/#1057): an unreadable `%TEMP%`
 * yields `degraded: false`, so a machine this cannot sample behaves exactly as it does today.
 * A preflight that blocks merges when its own sensor breaks is worse than no preflight.
 *
 * Node-only (`node:fs`/`node:os`): never a VALUE export from the `@agentic-kanban/shared/lib`
 * barrel (white-screens the client bundle, #791). Import via the deep path
 * `@agentic-kanban/shared/lib/temp-health`. Mirrors `machine-capacity.ts` / `git-exec.ts`.
 */

/**
 * Stop counting here. Measured: 100,324 entries walked in 12.7s, 707,242 exceeded 120s — the
 * curve is already steep well below the first number, so a directory holding 50,000 entries
 * is one the gate should not trust even though it is still walkable.
 */
export const DEFAULT_TEMP_ENTRY_CAP = 50_000;

/**
 * Wall-clock ceiling for the probe. Two seconds is generous for a healthy `%TEMP%` (the
 * measured box walked ~8,000 entries/second even while degraded) and is a rounding error
 * against the ~28-minute gate run it decides whether to start.
 */
export const DEFAULT_TEMP_PROBE_BUDGET_MS = 2_000;

/**
 * Env overrides for both bounds, mirroring `SMART_HOOKS_MIN_FREE_GB` on the capacity floor —
 * the established way this repo lets an operator (or a test) neutralise an AMBIENT machine read.
 *
 * The server's vitest setup raises the cap, and that is not a workaround: a unit test asserting
 * what `runPreMergeGate` does downstream must not turn red because the DEVELOPER's `%TEMP%` is
 * full. The probe's own behaviour is covered directly, against fixture directories it controls.
 * A malformed or non-positive value is IGNORED rather than honoured — an override that silently
 * disabled the floor by being unparseable is how a safety check quietly stops existing.
 */
function envInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface TempHealth {
  /** Entries seen before a bound was hit. NOT the directory total unless `complete`. */
  entries: number;
  /** The walk finished — `entries` is the true total and the directory is fast. */
  complete: boolean;
  /** Which bound stopped it, when one did. */
  stoppedBy: "entry_cap" | "time_budget" | null;
  elapsedMs: number;
  /** The verdict: `%TEMP%` is too big or too slow for a verify chain to be trusted on it. */
  degraded: boolean;
  /** Human-readable, for the hold message. Empty when healthy. */
  reason: string;
  /** The directory probed, so a hold message can name it. */
  dir: string;
}

/**
 * Walk `%TEMP%` under both bounds and report. Never throws.
 *
 * `opendirSync` + `readSync` rather than `readdir` deliberately: `readdir` materialises the
 * WHOLE directory before returning anything, so it cannot be bounded at all — on the 707k
 * machine it is the 120-second call itself. The iterator lets the walk stop.
 */
export function probeTempHealth(
  opts: { dir?: string; maxEntries?: number; budgetMs?: number } = {},
): TempHealth {
  const dir = opts.dir ?? tmpdir();
  // Read with LITERAL keys, not through a variable: `env-read-ownership.test.ts` scans for the
  // key text, and a dynamic `process.env[name]` is invisible to it — an env var nothing can
  // enumerate is one nobody can find when it misbehaves.
  const maxEntries = opts.maxEntries ?? envInt(process.env.KANBAN_TEMP_ENTRY_CAP) ?? DEFAULT_TEMP_ENTRY_CAP;
  const budgetMs =
    opts.budgetMs ?? envInt(process.env.KANBAN_TEMP_PROBE_BUDGET_MS) ?? DEFAULT_TEMP_PROBE_BUDGET_MS;
  const started = Date.now();

  let entries = 0;
  let stoppedBy: TempHealth["stoppedBy"] = null;
  let complete = false;
  try {
    const handle = opendirSync(dir);
    try {
      for (;;) {
        if (handle.readSync() === null) {
          complete = true;
          break;
        }
        entries++;
        if (entries >= maxEntries) {
          stoppedBy = "entry_cap";
          break;
        }
        // Check the clock in batches — `Date.now()` per entry would itself dominate a walk
        // whose whole point is that it must stay cheap.
        if (entries % 512 === 0 && Date.now() - started >= budgetMs) {
          stoppedBy = "time_budget";
          break;
        }
      }
    } finally {
      try {
        handle.closeSync();
      } catch {
        /* the walk already has its answer */
      }
    }
  } catch {
    // Fail open: an unreadable %TEMP% is not evidence of a bad one.
    return { entries: 0, complete: false, stoppedBy: null, elapsedMs: Date.now() - started, degraded: false, reason: "", dir };
  }

  const elapsedMs = Date.now() - started;
  if (stoppedBy === null) return { entries, complete, stoppedBy, elapsedMs, degraded: false, reason: "", dir };

  const reason =
    stoppedBy === "entry_cap"
      ? `${dir} holds at least ${entries} entries (cap ${maxEntries}) — at this size directory `
        + "enumeration alone stalls every process that touches it, which a test runner does "
        + "constantly (#1056)"
      : `${dir} could not be enumerated in ${budgetMs}ms (${entries} entries seen in ${elapsedMs}ms) `
        + "— it is too slow for a verify chain to be trusted on (#1056)";
  return { entries, complete, stoppedBy, elapsedMs, degraded: true, reason, dir };
}
