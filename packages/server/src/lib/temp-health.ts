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
 * Lives in `packages/server/src/lib/`, NOT in `shared/lib/`, and that is a correction rather
 * than a first choice: it was written in `shared` to mirror `machine-capacity.ts`, and
 * `shared-lib-single-consumer-ratchet.test.ts` failed it on the master sweep — only the server's
 * pre-merge gate consumes it, and #590's rule is that `shared/lib` is for what more than one
 * package needs. A single-consumer module there adds a package to every commit that touches it
 * and buys nothing. Move it back only when a second package actually imports it.
 */

/**
 * Stop counting here — and this number is a MEASUREMENT, after a first guess of 50,000 was
 * refuted within the hour.
 *
 * Four data points on the authoring box, all of `%TEMP%` on one machine over one morning:
 *
 * | entries | walk    | note                                            |
 * |---------|---------|-------------------------------------------------|
 * | 707,242 | > 120 s | the incident state — every touching process stalls |
 * | 100,324 |  12.7 s | cold cache                                      |
 * |  87,503 |   0.2 s | warm cache, minutes later, same directory       |
 *
 * The last two rows are the important pair: **a 13 % change in size moved the walk by 60x**,
 * because it was the CACHE that changed, not the directory. So elapsed time cannot be the
 * verdict — it would hold every merge on a cold box and admit on a warm one, for the same
 * `%TEMP%`. Size is the stable signal; time is only a bound on what the probe may cost.
 *
 * 250,000 sits above the whole observed working range (87k-100k, which the gate must not
 * refuse — those runs were fine) and far below the 707k that was fatal, while still catching
 * unbounded growth long before it reaches 120 s. A first draft used 50,000 on a "the curve is
 * steep" argument and would have held every merge on a box that enumerates in 0.2 s: a
 * threshold guessed from one end of a curve is how a safety check becomes a false positive.
 */
export const DEFAULT_TEMP_ENTRY_CAP = 250_000;

/**
 * Wall-clock ceiling. Hitting it is ALSO the degraded verdict — a directory the probe cannot
 * finish in this long is the 707k case, which is what the incident was — but the number is
 * chosen so a healthy `%TEMP%` never reaches it even cold: at the measured cold rate
 * (~7,900 entries/s) a directory below the cap's own working range walks in single-digit
 * seconds, and a warm one in a fifth of a second.
 *
 * 20 s is a real cost, paid only in the bad case, against the ~28-minute doomed run it exists
 * to prevent. A tighter budget was tried first (2 s) and is wrong for the same reason 50,000
 * was: on a cold cache it fires on a healthy machine.
 */
export const DEFAULT_TEMP_PROBE_BUDGET_MS = 20_000;

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
