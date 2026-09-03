/**
 * #1009 — through the REAL gate: a base-health run already in flight finishes BEFORE the
 * branch's verify_script starts, and the passing message says the gate waited for it.
 *
 * `runPreMergeGate` is exercised end-to-end with only the process-spawning helpers mocked (the
 * same seams `pre-merge-gate.service.test.ts` uses) plus the base-health service's in-flight
 * read, which is the one input this ordering hangs on.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import { setPreference } from "../repositories/preferences.repository.js";
import { verifyScriptPrefKey } from "../services/stack-profile.service.js";

const runSetupScript = vi.fn();
const getChangedFileNames = vi.fn();
vi.mock("@agentic-kanban/shared/lib/setup-script", () => ({
  runSetupScript: (...args: unknown[]) => runSetupScript(...args),
  DEFAULT_SETUP_SCRIPT_TIMEOUT_MS: 5 * 60 * 1000,
}));
vi.mock("@agentic-kanban/shared/lib/smoke-check", () => ({ runSmokeCheck: vi.fn() }));
vi.mock("../services/git.service.js", () => ({
  getChangedFileNames: (...args: unknown[]) => getChangedFileNames(...args),
}));

let inFlight: Promise<{ outcome: "green"; sha: string; branch: string; durationMs: number } | null> | null = null;
const verifyBaseBranchHealth = vi.fn();
vi.mock("../services/base-branch-health.service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    inFlightBaseBranchProbe: () => inFlight,
    verifyBaseBranchHealth: (...a: unknown[]) => verifyBaseBranchHealth(...(a as [])),
  };
});

const { runPreMergeGate } = await import("../services/pre-merge-gate.service.js");

describe("runPreMergeGate sequences against the base-health run (#1009)", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  beforeEach(() => {
    ({ db } = createTestDb());
    runSetupScript.mockReset();
    getChangedFileNames.mockReset();
    getChangedFileNames.mockResolvedValue(["src/Main.kt"]);
    verifyBaseBranchHealth.mockReset();
    inFlight = null;
  });

  it("waits for an in-flight base-health run before spawning the branch verify, and says so", async () => {
    await setPreference(verifyScriptPrefKey("p"), "gradlew.bat test", db);
    const order: string[] = [];
    let settle!: () => void;
    inFlight = new Promise((r) => { settle = () => { order.push("base-health done"); r({ outcome: "green", sha: "abc", branch: "master", durationMs: 1 }); }; });
    runSetupScript.mockImplementation(async () => { order.push("branch verify"); return { exitCode: 0, stdout: "ok", stderr: "" }; });

    const gate = runPreMergeGate({ id: "ws", workingDir: "/tmp/wt", baseBranch: "master" }, "p", db);
    await new Promise((r) => setTimeout(r, 50));
    // The branch verify has NOT started while the base run is still going.
    expect(runSetupScript).not.toHaveBeenCalled();
    settle();
    const res = await gate;

    expect(res.passed).toBe(true);
    expect(order).toEqual(["base-health done", "branch verify"]);
    // Reused, never a rival run.
    expect(verifyBaseBranchHealth).not.toHaveBeenCalled();
    expect(res.message).toContain("[base-health: joined an in-flight run");
    expect(res.message).toContain("base green");
  });

  it("says nothing about base-health when nothing was in flight and no sweep cadence is configured", async () => {
    await setPreference(verifyScriptPrefKey("p"), "gradlew.bat test", db);
    runSetupScript.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    const res = await runPreMergeGate({ id: "ws", workingDir: "/tmp/wt", baseBranch: "master" }, "p", db);
    expect(res.passed).toBe(true);
    expect(res.message).not.toContain("base-health");
    expect(verifyBaseBranchHealth).not.toHaveBeenCalled();
  });
});
