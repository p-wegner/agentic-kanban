// #1440: cold-clone check, impact-map build and train staging install run on a worker under
// verify_placement=worker, and spawn nothing on the host.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db/index.js";

const prefs = new Map<string, string>();
vi.mock("../repositories/preferences.repository.js", () => ({
  getPreference: async (key: string) => prefs.get(key) ?? null,
}));
vi.mock("../services/git.service.js", () => ({
  revParse: async () => "c".repeat(40),
  cloneBranchTo: vi.fn(async () => { throw new Error("host clone must not run"); }),
}));
vi.mock("@agentic-kanban/shared/lib/git-exec", () => ({
  gitExecOrThrow: async () => "c".repeat(40) + "\n",
  gitExec: async () => ({ stdout: "", stderr: "", code: 0, error: null }),
}));

import { runColdCloneBuildCheck } from "../services/cold-clone-build-check.service.js";
import { trainGateWorkerName } from "../services/merge-train-placement.js";
import { IMPACT_MAP_BEGIN, IMPACT_MAP_END, runImpactMapBuildOnWorker } from "../services/test-impact-map/worker-build.js";
import type { VerifyWorkerRunner } from "../services/verify-job-placement.js";

const db = {} as Database;
const profile = { installCommand: "pnpm install", buildCommand: "pnpm build" } as never;
const worker = (log = "ok", passed = true): VerifyWorkerRunner & { jobs: string[] } => {
  const jobs: string[] = [];
  return {
    jobs,
    listWorkers: () => [{ id: "w1", name: "desktop-stable", freeSlots: 1 }],
    run: async (req) => { jobs.push(`${req.kind}:${req.command}`); return { requestId: req.requestId, workerId: req.workerId, sha: req.sha, tier: req.tier, passed, log, exitCode: passed ? 0 : 1 }; },
  };
};
const place = () => { prefs.set("verify_placement_p1", "worker"); prefs.set("verify_workers_p1", "desktop-stable"); };

describe("host-only verify work on workers (#1440)", () => {
  it("cold-clone check runs install+build on the worker, never clones on the host", async () => {
    place();
    const w = worker();
    const runner = vi.fn();
    const r = await runColdCloneBuildCheck({ repoPath: "/repo", branch: "feature/x" }, profile, { runner, placement: { projectId: "p1", database: db, workerRunner: w } });
    expect(r.ok).toBe(true);
    expect(w.jobs[0]).toMatch(/^cold-clone-build:.*pnpm build/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("cold-clone check holds with a reason when no worker is eligible", async () => {
    place();
    const r = await runColdCloneBuildCheck({ repoPath: "/repo", branch: "feature/x" }, profile, { runner: vi.fn(), placement: { projectId: "p1", database: db, workerRunner: null } });
    expect(r).toMatchObject({ ok: false, reason: "held" });
    expect(r.output).toContain("held");
  });

  it("impact map is built on the worker and the artifact stored by the board", async () => {
    place();
    const repo = mkdtempSync(join(tmpdir(), "ak-impact-"));
    const w = worker(`noise\n${IMPACT_MAP_BEGIN}\n{"v":1}\n${IMPACT_MAP_END}\n`);
    const mapPath = join(repo, "docs", "tests", "impact-map.json");
    const out = await runImpactMapBuildOnWorker({ placement: { projectId: "p1", database: db, workerRunner: w }, repoPath: repo, tool: join(repo, ".claude/skills/test-impact/tools/impact.mjs"), durations: null, mapPath });
    expect(out).toMatchObject({ ok: true, workerName: "desktop-stable" });
    expect(readFileSync(mapPath, "utf8")).toBe('{"v":1}');
    expect(w.jobs[0]).toContain("impact.mjs");
  });

  it("impact map build holds when no worker is eligible", async () => {
    place();
    const out = await runImpactMapBuildOnWorker({ placement: { projectId: "p1", database: db, workerRunner: null }, repoPath: tmpdir(), tool: "t", durations: null, mapPath: join(tmpdir(), "m.json") });
    expect(out).toMatchObject({ ok: false, held: true });
  });

  it("impact map placed on the host returns null (caller builds as before)", async () => {
    prefs.clear();
    expect(await runImpactMapBuildOnWorker({ placement: { projectId: "p1", database: db, workerRunner: worker() }, repoPath: tmpdir(), tool: "t", durations: null, mapPath: "m" })).toBeNull();
  });

  it("train staging names the worker only under worker placement", async () => {
    prefs.clear();
    expect(await trainGateWorkerName("p1", db, "t1")).toBeNull();
  });
});
