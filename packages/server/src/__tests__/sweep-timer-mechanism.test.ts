// @gate:always-run — recursively scans the startup/ and services/ source trees, so its
// subject is not in this file's import graph and scoped test selection must not skip it.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Background sweeps schedule through `startPeriodicSweep`, never a raw timer pair (#609).
 *
 * #529 introduced the helper and migrated every sweep. That alone does not hold: a NEW
 * reconciler (`base-branch-health-reconciler`) landed on hand-rolled
 * `setTimeout`+`setInterval` the SAME DAY the helper was written, because nothing stopped
 * it. The helper is only a convention until a rule enforces it.
 *
 * The three things a hand-rolled pair gets wrong, all silent:
 *  - `if (timer) return` instead of stop-then-restart, so a tsx-watch reload keeps the
 *    OLD closure's sweep running forever and never arms the new code;
 *  - no boot-delay run, so crash recovery waits a full interval (30 min for some);
 *  - no `unref`, so the timer holds the process open — invisible in the server (its
 *    socket does that anyway) and surfacing as a test/CLI run that will not exit.
 *
 * ALLOWLIST IS EMPTY on purpose. The ticket planned a shrinking baseline of 11 files;
 * migrating the last one first meant the rule could ship at zero tolerance instead, and a
 * baseline that starts empty can never be quietly grown.
 */
const SRC = path.resolve(import.meta.dirname, "..");

/** Files whose NAME declares them a periodic sweep. */
const SWEEP_NAME = /-(reconciler|reaper|scanner|sweep)\.ts$|(pruner|watchdog|heartbeat)[^/\\]*\.ts$/;

/**
 * Deliberate exceptions, each with the reason it cannot use the helper.
 *
 * Only the mechanism itself. This is the same shape as the git-spawn guard allowing
 * `git-exec.ts`: the adapter is where the raw primitive is SUPPOSED to live, and a rule
 * that forbade it there would forbid implementing the rule's own escape hatch.
 */
const ALLOWED: Record<string, string> = {
  "lib/periodic-sweep.ts": "the helper itself — it is where setInterval is sanctioned to live",
};

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "__tests__" ? [] : tsFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("background sweeps schedule through startPeriodicSweep (#609)", () => {
  const sweepFiles = tsFiles(SRC).filter((f) => SWEEP_NAME.test(f));

  it("finds the sweep files, so the scan cannot silently match nothing", () => {
    // A regex that stops matching would make every assertion below vacuously true —
    // the failure mode this whole suite exists to prevent.
    expect(sweepFiles.length).toBeGreaterThanOrEqual(10);
  });

  it("no sweep file schedules with a raw setInterval", () => {
    const offenders = sweepFiles
      .filter((file) => {
        const rel = path.relative(SRC, file).replaceAll("\\", "/");
        if (rel in ALLOWED) return false;
        return /\bsetInterval\s*\(/.test(readFileSync(file, "utf8"));
      })
      .map((file) => path.relative(SRC, file).replaceAll("\\", "/"));

    expect(
      offenders,
      `these schedule by hand instead of startPeriodicSweep:\n${offenders.join("\n")}\n` +
        "Use startPeriodicSweep from lib/periodic-sweep.ts, or add an entry to ALLOWED with a reason.",
    ).toEqual([]);
  });

  it("every allowlist entry names a file that still exists", () => {
    // An allowlist outliving its file is how a zero-tolerance rule rots back into a
    // baseline nobody re-checks.
    const known = new Set(sweepFiles.map((f) => path.relative(SRC, f).replaceAll("\\", "/")));
    expect(Object.keys(ALLOWED).filter((f) => !known.has(f))).toEqual([]);
  });
});
