import { existsSync } from "node:fs";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import { setPreference } from "../repositories/preferences.repository.js";
import { saveStackProfile, verifyScriptPrefKey } from "../services/stack-profile.service.js";
import type { StackProfile } from "@agentic-kanban/shared";

// The pre-merge gate runs two heavyweight shared helpers (verify_script via runSetupScript, the
// boot/render smoke via runSmokeCheck). Mock both so the test exercises the GATE'S decision logic
// (#821) without spawning real processes / dev servers.
const runSetupScript = vi.fn();
const runSmokeCheck = vi.fn();
const getChangedFileNames = vi.fn();
vi.mock("@agentic-kanban/shared/lib/setup-script", () => ({
  runSetupScript: (...args: unknown[]) => runSetupScript(...args),
  DEFAULT_SETUP_SCRIPT_TIMEOUT_MS: 5 * 60 * 1000,
}));
vi.mock("@agentic-kanban/shared/lib/smoke-check", () => ({
  runSmokeCheck: (...args: unknown[]) => runSmokeCheck(...args),
}));
vi.mock("../services/git.service.js", () => ({
  getChangedFileNames: (...args: unknown[]) => getChangedFileNames(...args),
}));

const { runPreMergeGate } = await import("../services/pre-merge-gate.service.js");

function webProfile(overrides: Partial<StackProfile> = {}): StackProfile {
  return {
    stack: "java", packageManager: "gradle", isMonorepo: false, workspaces: [],
    installCommand: null, buildCommand: ".\\gradlew.bat build", testCommand: ".\\gradlew.bat test",
    quickTestCommand: null, lintCommand: null, typecheckCommand: null, devCommand: ".\\gradlew.bat run",
    isWeb: true, devHealthUrl: "http://127.0.0.1:8080", devPort: 8080, testDir: null, testRunner: "gradle",
    source: "detected", detectedMarkers: ["build.gradle.kts"], updatedAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("runPreMergeGate (#821) — shared verify+smoke gate the monitor's auto_merge_in_review path must run", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  beforeEach(() => {
    ({ db } = createTestDb());
    runSetupScript.mockReset();
    runSmokeCheck.mockReset();
    getChangedFileNames.mockReset();
    getChangedFileNames.mockResolvedValue([]);
  });

  it("no-op (skipped, passed) when neither a verify_script nor a web profile is configured", async () => {
    const res = await runPreMergeGate({ id: "ws1", workingDir: "/tmp/wt" }, "proj-none", db);
    expect(res).toMatchObject({ passed: true, skipped: true, stage: "none" });
    expect(runSetupScript).not.toHaveBeenCalled();
    expect(runSmokeCheck).not.toHaveBeenCalled();
  });

  it("passes when verify_script exits 0", async () => {
    await setPreference(verifyScriptPrefKey("p"), ".\\gradlew.bat test", db);
    runSetupScript.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    const res = await runPreMergeGate({ id: "ws", workingDir: "/tmp/wt" }, "p", db);
    expect(res.passed).toBe(true);
    expect(res.skipped).toBe(false);
    expect(runSetupScript).toHaveBeenCalledTimes(1);
  });

  it("FAILS (withholds merge) when verify_script exits non-zero", async () => {
    await setPreference(verifyScriptPrefKey("p"), ".\\gradlew.bat test", db);
    runSetupScript.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "compile error" });
    const res = await runPreMergeGate({ id: "ws", workingDir: "/tmp/wt" }, "p", db);
    expect(res.passed).toBe(false);
    expect(res.stage).toBe("verify");
    expect(res.message).toContain("compile error");
    expect(runSmokeCheck).not.toHaveBeenCalled(); // short-circuits before smoke
  });

  it("#192: a timed-out verify_script is reported as inconclusive/retryable, NOT a build/test failure", async () => {
    await setPreference(verifyScriptPrefKey("p"), ".\\gradlew.bat test", db);
    runSetupScript.mockResolvedValue({ exitCode: 124, stdout: "", stderr: "", timedOut: true });
    const res = await runPreMergeGate({ id: "ws", workingDir: "/tmp/wt" }, "p", db);
    expect(res.passed).toBe(false);
    expect(res.stage).toBe("verify");
    expect(res.timedOut).toBe(true);
    expect(res.message).toContain("timed out");
    expect(res.message).not.toContain("failed (exit");
    // runSetupScript is called with an explicit timeoutMs budget, not the bare (script) form.
    expect(runSetupScript).toHaveBeenCalledWith("/tmp/wt", ".\\gradlew.bat test", expect.objectContaining({ timeoutMs: expect.any(Number) }));
  });

  it("#192: a per-project verify_timeout_ms_<projectId> override is passed through to runSetupScript", async () => {
    await setPreference(verifyScriptPrefKey("p"), ".\\gradlew.bat test", db);
    await setPreference("verify_timeout_ms_p", "600000", db);
    runSetupScript.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
    await runPreMergeGate({ id: "ws", workingDir: "/tmp/wt" }, "p", db);
    expect(runSetupScript).toHaveBeenCalledWith("/tmp/wt", ".\\gradlew.bat test", { timeoutMs: 600000, env: expect.objectContaining({ GRADLE_USER_HOME: expect.any(String) }) });
  });

  // #194: the verify gate's gradle must land in the SAME per-worktree home the builder's
  // own gradle used, so they cooperate on one daemon instead of a shared global default.
  it("#194: verify_script runs with a GRADLE_USER_HOME derived from the workspace's worktree", async () => {
    await setPreference(verifyScriptPrefKey("p"), ".\\gradlew.bat test", db);
    runSetupScript.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    await runPreMergeGate({ id: "ws", workingDir: "/tmp/wt" }, "p", db);
    const call = runSetupScript.mock.calls[0];
    expect(call[2].env.GRADLE_USER_HOME).toContain("kanban-gradle-homes");
    expect(call[2].env.GRADLE_USER_HOME).toContain("wt");
  });

  it("fail-closed: verify_script configured but NO worktree → fails, doesn't approve unverifiable work", async () => {
    await setPreference(verifyScriptPrefKey("p"), ".\\gradlew.bat test", db);
    const res = await runPreMergeGate({ id: "ws", workingDir: null }, "p", db);
    expect(res.passed).toBe(false);
    expect(res.stage).toBe("verify");
    expect(runSetupScript).not.toHaveBeenCalled();
  });

  it("runs the smoke check for a web project and FAILS when boot/render fails", async () => {
    await saveStackProfile("p", webProfile(), db);
    runSmokeCheck.mockResolvedValue({ passed: false, skipped: false, status: 0, message: "server never came up", bodySnippet: "" });
    const res = await runPreMergeGate({ id: "ws", workingDir: "/tmp/wt" }, "p", db);
    expect(res.passed).toBe(false);
    expect(res.stage).toBe("smoke");
    expect(res.message).toContain("server never came up");
  });

  it("passes the smoke check for a web project when boot/render succeeds", async () => {
    await saveStackProfile("p", webProfile(), db);
    runSmokeCheck.mockResolvedValue({ passed: true, skipped: false, status: 200, message: "ok", bodySnippet: "" });
    const res = await runPreMergeGate({ id: "ws", workingDir: "/tmp/wt" }, "p", db);
    expect(res.passed).toBe(true);
    expect(res.skipped).toBe(false);
    expect(res.stage).toBe("smoke");
  });

  it("smoke harness ERROR is non-fatal — gate passes when the smoke helper throws", async () => {
    await saveStackProfile("p", webProfile(), db);
    runSmokeCheck.mockRejectedValue(new Error("playwright harness blew up"));
    const res = await runPreMergeGate({ id: "ws", workingDir: "/tmp/wt" }, "p", db);
    expect(res.passed).toBe(true);
  });

  it("fail-closed: web project (smoke applies) but NO worktree → fails", async () => {
    await saveStackProfile("p", webProfile(), db);
    const res = await runPreMergeGate({ id: "ws", workingDir: null }, "p", db);
    expect(res.passed).toBe(false);
    expect(res.stage).toBe("smoke");
    expect(runSmokeCheck).not.toHaveBeenCalled();
  });

  // #198: a docs-only diff can never change boot/render behavior, so the smoke check is
  // skipped entirely rather than paying for a cold-JVM-hostile boot poll whose outcome
  // can't have changed.
  it("#198: skips the smoke check entirely for a docs-only diff (baseBranch provided)", async () => {
    await saveStackProfile("p", webProfile(), db);
    getChangedFileNames.mockResolvedValue(["docs/state.md", "README.md"]);
    const res = await runPreMergeGate({ id: "ws", workingDir: "/tmp/wt", baseBranch: "master" }, "p", db);
    expect(res.passed).toBe(true);
    expect(res.skipped).toBe(true);
    expect(res.stage).toBe("none");
    expect(runSmokeCheck).not.toHaveBeenCalled();
  });

  it("#198: still runs the smoke check when the diff touches a source file alongside docs", async () => {
    await saveStackProfile("p", webProfile(), db);
    getChangedFileNames.mockResolvedValue(["docs/state.md", "src/Main.kt"]);
    runSmokeCheck.mockResolvedValue({ passed: true, skipped: false, status: 200, message: "ok", bodySnippet: "" });
    const res = await runPreMergeGate({ id: "ws", workingDir: "/tmp/wt", baseBranch: "master" }, "p", db);
    expect(res.passed).toBe(true);
    expect(res.stage).toBe("smoke");
    expect(runSmokeCheck).toHaveBeenCalledTimes(1);
  });

  it("#198: runs the smoke check as before when no baseBranch is provided (can't evaluate the diff)", async () => {
    await saveStackProfile("p", webProfile(), db);
    runSmokeCheck.mockResolvedValue({ passed: true, skipped: false, status: 200, message: "ok", bodySnippet: "" });
    const res = await runPreMergeGate({ id: "ws", workingDir: "/tmp/wt" }, "p", db);
    expect(res.passed).toBe(true);
    expect(res.stage).toBe("smoke");
    expect(runSmokeCheck).toHaveBeenCalledTimes(1);
    expect(getChangedFileNames).not.toHaveBeenCalled();
  });

  it("runs verify THEN smoke when both are configured (both must pass)", async () => {
    await setPreference(verifyScriptPrefKey("p"), ".\\gradlew.bat test", db);
    await saveStackProfile("p", webProfile(), db);
    runSetupScript.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    runSmokeCheck.mockResolvedValue({ passed: true, skipped: false, status: 200, message: "ok", bodySnippet: "" });
    const res = await runPreMergeGate({ id: "ws", workingDir: "/tmp/wt" }, "p", db);
    expect(res.passed).toBe(true);
    expect(runSetupScript).toHaveBeenCalledTimes(1);
    expect(runSmokeCheck).toHaveBeenCalledTimes(1);
  });

  // ---- #362: the gate's AGENTIC_KANBAN_DIR must not survive the gate ----------------------
  //
  // Measured before the fix: 710 `kanban-verify-gate-*` directories in %TEMP% over two days,
  // one per gate run, each able to hold a throwaway SQLite DB. The directory is created for
  // the verify child's `AGENTIC_KANBAN_DIR` (#231) and was never removed on ANY path — and
  // this branch has four early returns, so the two that matter most are the FAILING ones.
  function gateDataDirFromLastCall(): string {
    const env = (runSetupScript.mock.calls.at(-1)?.[2] as { env?: Record<string, string> } | undefined)?.env;
    const dir = env?.AGENTIC_KANBAN_DIR;
    expect(dir, "the gate must pass AGENTIC_KANBAN_DIR to the verify child").toBeTruthy();
    return dir as string;
  }

  it("#362: removes the gate data dir after a PASSING verify run", async () => {
    await setPreference(verifyScriptPrefKey("p"), ".\\gradlew.bat test", db);
    runSetupScript.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    const res = await runPreMergeGate({ id: "ws", workingDir: "/tmp/wt" }, "p", db);
    expect(res.passed).toBe(true);
    const dir = gateDataDirFromLastCall();
    expect(dir).toContain("kanban-verify-gate-");
    expect(existsSync(dir)).toBe(false);
  });

  it("#362: removes the gate data dir when verify FAILS (an early-return path)", async () => {
    await setPreference(verifyScriptPrefKey("p"), ".\\gradlew.bat test", db);
    runSetupScript.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "compile error" });
    const res = await runPreMergeGate({ id: "ws", workingDir: "/tmp/wt" }, "p", db);
    expect(res.passed).toBe(false);
    expect(existsSync(gateDataDirFromLastCall())).toBe(false);
  });

  it("#362: removes the gate data dir when verify TIMES OUT (the other early-return path)", async () => {
    await setPreference(verifyScriptPrefKey("p"), ".\\gradlew.bat test", db);
    runSetupScript.mockResolvedValue({ exitCode: 124, stdout: "", stderr: "", timedOut: true });
    const res = await runPreMergeGate({ id: "ws", workingDir: "/tmp/wt" }, "p", db);
    expect(res.timedOut).toBe(true);
    expect(existsSync(gateDataDirFromLastCall())).toBe(false);
  });

  it("#362: removes the gate data dir when the verify script THROWS", async () => {
    await setPreference(verifyScriptPrefKey("p"), ".\\gradlew.bat test", db);
    // `runSetupScript` rejecting is already caught inside the gate, so capture the dir the
    // gate handed the child and assert the `finally` still ran.
    let captured = "";
    runSetupScript.mockImplementation((_wd: string, _script: string, opts: { env?: Record<string, string> }) => {
      captured = opts.env?.AGENTIC_KANBAN_DIR ?? "";
      return Promise.reject(new Error("spawn failed"));
    });
    const res = await runPreMergeGate({ id: "ws", workingDir: "/tmp/wt" }, "p", db);
    expect(res.passed).toBe(false);
    expect(captured).toContain("kanban-verify-gate-");
    expect(existsSync(captured)).toBe(false);
  });
});
