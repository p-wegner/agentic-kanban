import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import { setPreference } from "../repositories/preferences.repository.js";
import { saveStackProfile, verifyScriptPrefKey } from "../services/stack-profile.service.js";
import { projectHasMergeGate } from "../startup/monitor-cycle.js";
import type { StackProfile } from "@agentic-kanban/shared";

function webProfile(overrides: Partial<StackProfile> = {}): StackProfile {
  return {
    stack: "java", packageManager: "gradle", isMonorepo: false, workspaces: [],
    installCommand: null, buildCommand: ".\\gradlew.bat build", testCommand: ".\\gradlew.bat test",
    quickTestCommand: null, lintCommand: null, typecheckCommand: null, devCommand: ".\\gradlew.bat run",
    isWeb: true, devHealthUrl: null, devPort: 8080, testDir: null, testRunner: "gradle",
    source: "detected", detectedMarkers: ["build.gradle.kts"], updatedAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("projectHasMergeGate (#821) — the monitor must not bypass readyForMerge for gated projects", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  beforeEach(() => { ({ db } = createTestDb()); });

  it("true when a verify_script is configured", async () => {
    const pid = "proj-verify";
    await setPreference(verifyScriptPrefKey(pid), ".\\gradlew.bat test && .\\gradlew.bat build", db);
    expect(await projectHasMergeGate(pid, db)).toBe(true);
  });

  it("true when the stack profile is a web project (smoke check applies)", async () => {
    const pid = "proj-web";
    await saveStackProfile(pid, webProfile(), db);
    expect(await projectHasMergeGate(pid, db)).toBe(true);
  });

  it("false when neither a verify_script nor a web profile is present", async () => {
    expect(await projectHasMergeGate("proj-none", db)).toBe(false);
  });

  it("false for a non-web profile with no verify_script (library/CLI — nothing to gate)", async () => {
    const pid = "proj-lib";
    await saveStackProfile(pid, webProfile({ isWeb: false, devCommand: null, devPort: null }), db);
    expect(await projectHasMergeGate(pid, db)).toBe(false);
  });
});
