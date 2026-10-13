// #1429 — a strict worker-dispatch project installs on the worker, never on the host.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Database } from "../db/index.js";

const prefs = new Map<string, string>();
vi.mock("../repositories/session-lifecycle.repository.js", () => ({
  getPreferenceValue: async (key: string) => prefs.get(key) ?? null,
}));
vi.mock("../repositories/stack-profile.repository.js", () => ({
  getProjectSetupScript: async () => "pnpm install -r",
}));

const { projectDepsLiveOnWorker, depsOnWorkerSetupRun, DEPS_ON_WORKER_LABEL } = await import("../services/worker-deps-placement.js");
const { refreshWorkspaceBuildArtifacts } = await import("../services/workspace-build-refresh.service.js");
const { workerDispatchPrefKey, workerStrictPrefKey } = await import("../services/worker-fleet.service.js");

const db = {} as Database;

describe("projectDepsLiveOnWorker (#1429)", () => {
  beforeEach(() => prefs.clear());

  it("is false without dispatch, or with dispatch but not strict (the host may still run it)", async () => {
    expect(await projectDepsLiveOnWorker("p1", db)).toBe(false);
    prefs.set(workerDispatchPrefKey("p1"), "true");
    expect(await projectDepsLiveOnWorker("p1", db)).toBe(false);
  });

  it("is true for dispatch + strict", async () => {
    prefs.set(workerDispatchPrefKey("p1"), "true");
    prefs.set(workerStrictPrefKey("p1"), "true");
    expect(await projectDepsLiveOnWorker("p1", db)).toBe(true);
    expect(await projectDepsLiveOnWorker("other", db)).toBe(false);
  });

  it("marks the setup record as skipped with the deps-on-worker label", () => {
    const run = depsOnWorkerSetupRun("pnpm install -r");
    expect(run.state).toBe("skipped");
    expect(run.stdoutTail).toBe(DEPS_ON_WORKER_LABEL);
  });

  it("post-rebase rebuild does not spawn the setup script for a strict project", async () => {
    prefs.set(workerDispatchPrefKey("p1"), "true");
    prefs.set(workerStrictPrefKey("p1"), "true");
    const runScript = vi.fn();
    const result = await refreshWorkspaceBuildArtifacts({
      workingDir: "/wt", projectId: "p1", database: db, headShaBefore: "a", headShaAfter: "b", runScript: runScript as never,
    });
    expect(result).toBe("skipped-on-worker");
    expect(runScript).not.toHaveBeenCalled();
  });
});
