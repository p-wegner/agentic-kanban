// @gate:always-run — walks `startup/` and `services/`; imports nothing it checks.
/**
 * #584 — `background sweep` is a named kind, and its registry is complete.
 *
 * A sweep is a crash-safe periodic pass over DB state: `reconcileX(deps, now?) -> Report`
 * behind a module-singleton timer pair `startX(deps, intervalMs)` / `stopX()`. Seventeen of
 * them exist under six different nouns (reconciler, reaper, scanner, scheduler, orchestrator,
 * pruner), and `BACKGROUND_SERVICES` in `startup/background-services.ts` is what actually runs
 * them — array order is start order, reversed shutdown order.
 *
 * The failure this prevents is silent by construction: a sweep whose module is written, tested
 * and exported but never added to the registry simply never runs. Nothing imports it, no test
 * fails, and the drift it was written to repair keeps accumulating. Three sweeps living under
 * `services/` rather than `startup/` (`monitor-butler`, `session-message-pruner`,
 * `project-conductor`) are exactly the shape that goes missing, so the scan covers both dirs
 * and does not care where the file sits.
 *
 * Pairs that are NOT sweeps — started on demand for one project or one request rather than by
 * the composition root — carry a reason here instead. That list is the point of the guard: it
 * makes "this one is deliberately not registered" a written claim rather than an omission.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walkPackageSources } from "../../../shared/__tests__/helpers/guard-scan.js";
import { BACKGROUND_SERVICES } from "../startup/background-services.js";

const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_FILE = path.join(serverSrc, "startup", "background-services.ts");

/** start/stop pairs that are deliberately NOT background sweeps, each with its reason. */
const NOT_A_SWEEP: Record<string, string> = {
  startConductor:
    "per-project Conductor loop, started/stopped by the operator via POST /api/projects/:id/conductor",
  startDevServer:
    "starts a project's dev server on request (dev-server skill / plugin views), not a periodic pass",
  startGitHttpServer:
    "opt-in listener for the worker fleet's git transport, bound once by the fleet entrypoint",
};

interface Pair {
  start: string;
  file: string;
}

function collectStartStopPairs(): Pair[] {
  const pairs: Pair[] = [];
  for (const dir of ["startup", "services"]) {
    for (const file of walkPackageSources(path.join(serverSrc, dir))) {
      const source = fs.readFileSync(file, "utf-8");
      const starts = [...source.matchAll(/^export (?:async )?function (start[A-Z]\w*)/gm)].map((m) => m[1]);
      const stops = new Set([...source.matchAll(/^export (?:async )?function (stop[A-Z]\w*)/gm)].map((m) => m[1]));
      for (const start of starts) {
        if (!stops.has("stop" + start.slice("start".length))) continue;
        pairs.push({ start, file: path.relative(serverSrc, file).replace(/\\/g, "/") });
      }
    }
  }
  return pairs;
}

describe("every background sweep is registered (#584)", () => {
  const pairs = collectStartStopPairs();
  const registrySource = fs.readFileSync(REGISTRY_FILE, "utf-8");

  it("finds the kind at all — a rule over an empty set guards nothing", () => {
    expect(pairs.length).toBeGreaterThanOrEqual(17);
  });

  it("each start/stop pair is either in BACKGROUND_SERVICES or listed here as not-a-sweep", () => {
    const unaccounted = pairs
      .filter((p) => !registrySource.includes(p.start) && !(p.start in NOT_A_SWEEP))
      .map((p) => `${p.file}:${p.start}`);
    expect(unaccounted).toEqual([]);
  });

  it("the not-a-sweep list has no stale entries — a registered pair must not also claim exemption", () => {
    const contradictory = Object.keys(NOT_A_SWEEP).filter((name) => registrySource.includes(name));
    expect(contradictory).toEqual([]);
    const vanished = Object.keys(NOT_A_SWEEP).filter((name) => !pairs.some((p) => p.start === name));
    expect(vanished).toEqual([]);
  });

  it("pins the start order, which is also the reversed shutdown order the registry calls stable", () => {
    expect(BACKGROUND_SERVICES.map((s) => s.name)).toEqual([
      "scheduled-tasks",
      "auto-merge-orchestrator",
      "stranded-review-reconciler",
      "stranded-plan-reconciler",
      "zombie-fix-session-reconciler",
      "ancestor-branch-reconciler",
      "born-blocked-reconciler",
      "workflow-node-divergence-reconciler",
      "done-unmerged-scanner",
      "terminal-workspace-reaper",
      "service-stack-reaper",
      "monitor-butler",
      "project-conductor-supervisor",
      "backup-scheduler",
      "session-message-pruner",
      "base-branch-health-reconciler",
    ]);
  });

  it("every registered service has a unique name — the registry is addressed by name", () => {
    const names = BACKGROUND_SERVICES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
