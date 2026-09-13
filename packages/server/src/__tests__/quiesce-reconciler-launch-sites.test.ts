// @gate:always-run — walks `startup/`; reaches state (file text) outside its own import graph.
/**
 * #1113 (follow-up to #1108) — every direct `startSession` call under `startup/` is either
 * quiesce-gated or consciously exempted, so a NEW one can't silently reopen the gap.
 *
 * #1108 wired the quiesce hold into the two chokepoints every workspace-creating/agent-launching
 * path is SUPPOSED to funnel through (`workspace-create.service.ts::createWorkspace` and
 * `workspace-session.service.ts::launchSession`, both via `services/quiesce.service.ts`). But a
 * `git grep` for `.startSession(` under `startup/` turned up five call sites that reach the
 * session manager DIRECTLY, bypassing both chokepoints:
 *
 *   - `plan-mode-reconciler.ts`   — stranded plan-mode recovery relaunch
 *   - `merge-workflow.ts`         — the pre-merge and post-merge learning/verify sessions (two
 *                                   call sites in one file)
 *   - `exit/usage-limit-exit.ts`  — relaunch after a usage-limit exit
 *   - `exit/review-launch.ts`     — auto-review launch
 *   - `exit/learning-step.ts`     — compounding-engineering learning-step launch
 *
 * Each now carries its own `assertProjectNotQuiesced` call (see the `#1113` comments in those
 * files). This guard is what keeps that true: it re-derives the same `git grep`, and fails on any
 * matching file that does not import `assertProjectNotQuiesced` — unless the file is listed below
 * with a reason. `monitor-workspace-actions.ts` calls `workspaceService.launchSession(...)`
 * instead (the gated chokepoint itself), so it never matches this scan in the first place.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { walkPackageSources } from "../../../shared/__tests__/helpers/guard-scan.js";

const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STARTUP_DIR = path.join(serverSrc, "startup");

/**
 * A `startup/` file that calls `.startSession(` directly but is deliberately NOT gated, with the
 * reason. Empty today — every known direct call site under `startup/` is gated (#1113). A future
 * exemption goes here, not silently.
 */
const NOT_GATED: Record<string, string> = {};

const DIRECT_START_SESSION_CALL = /\.startSession\(/;

function findDirectStartSessionCallers(): string[] {
  const offenders: string[] = [];
  for (const file of walkPackageSources(STARTUP_DIR)) {
    const source = fs.readFileSync(file, "utf-8");
    if (!DIRECT_START_SESSION_CALL.test(source)) continue;
    const rel = path.relative(serverSrc, file).replace(/\\/g, "/");
    offenders.push(rel);
  }
  return offenders;
}

describe("every direct startSession call under startup/ is quiesce-gated or exempted (#1113)", () => {
  const callers = findDirectStartSessionCallers();

  it("finds the kind at all — a rule over an empty set guards nothing", () => {
    expect(callers.length).toBeGreaterThanOrEqual(5);
  });

  it("each caller either imports assertProjectNotQuiesced or is listed in NOT_GATED with a reason", () => {
    const unaccounted = callers.filter((rel) => {
      if (rel in NOT_GATED) return false;
      const source = fs.readFileSync(path.join(serverSrc, rel), "utf-8");
      return !source.includes("assertProjectNotQuiesced");
    });
    expect(unaccounted).toEqual([]);
  });

  it("NOT_GATED has no stale entries — an exempted file must still actually skip the guard", () => {
    const contradictory = Object.keys(NOT_GATED).filter((rel) => {
      const full = path.join(serverSrc, rel);
      if (!fs.existsSync(full)) return true; // exemption for a file that no longer exists
      return fs.readFileSync(full, "utf-8").includes("assertProjectNotQuiesced");
    });
    expect(contradictory).toEqual([]);
  });
});
