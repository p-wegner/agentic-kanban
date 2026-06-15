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
vi.mock("@agentic-kanban/shared/lib/setup-script", () => ({
  runSetupScript: (...args: unknown[]) => runSetupScript(...args),
}));
vi.mock("@agentic-kanban/shared/lib/smoke-check", () => ({
  runSmokeCheck: (...args: unknown[]) => runSmokeCheck(...args),
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
});
