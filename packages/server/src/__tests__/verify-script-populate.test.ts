import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { StackProfile } from "@agentic-kanban/shared";
import { createTestDb } from "./helpers/test-db.js";
import {
  deriveVerifyScriptFromProfile,
  populateVerifyScript,
  verifyScriptPrefKey,
} from "../services/stack-profile.service.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kanban-verify-pop-"));
}

function profile(overrides: Partial<StackProfile>): StackProfile {
  return {
    stack: "node", packageManager: "pnpm", isMonorepo: false, workspaces: [],
    installCommand: "pnpm install", buildCommand: null, testCommand: null, quickTestCommand: null,
    lintCommand: null, typecheckCommand: null, devCommand: null, isWeb: false,
    devHealthUrl: null, devPort: null, testDir: null, testRunner: null,
    source: "detected", detectedMarkers: [], updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("deriveVerifyScriptFromProfile", () => {
  it("joins testCommand and buildCommand from the profile", () => {
    const p = profile({ testCommand: "pnpm test", buildCommand: "pnpm run build" });
    expect(deriveVerifyScriptFromProfile(p, "/nope")).toBe("pnpm test && pnpm run build");
  });

  it("uses just testCommand when there is no buildCommand", () => {
    const p = profile({ testCommand: "cargo test", buildCommand: null });
    expect(deriveVerifyScriptFromProfile(p, "/nope")).toBe("cargo test");
  });

  it("falls back to marker rules when the profile has neither test nor build", async () => {
    const dir = await tmp();
    try {
      await writeFile(join(dir, "go.mod"), "module x\n\ngo 1.22\n");
      const p = profile({ stack: null, testCommand: null, buildCommand: null });
      expect(deriveVerifyScriptFromProfile(p, dir)).toBe("go test ./...");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to marker rules when there is no profile at all", async () => {
    const dir = await tmp();
    try {
      await writeFile(join(dir, "Cargo.toml"), "[package]\nname = \"x\"\n");
      expect(deriveVerifyScriptFromProfile(null, dir)).toBe("cargo test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns empty string when nothing can be derived", async () => {
    const dir = await tmp();
    try {
      expect(deriveVerifyScriptFromProfile(null, dir)).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("populateVerifyScript", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tmp();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists the derived verify script to verify_script_<projectId>", async () => {
    const { db } = createTestDb();
    const p = profile({ testCommand: "pnpm test", buildCommand: "pnpm run build" });
    const written = await populateVerifyScript("proj-1", dir, db, p);
    expect(written).toBe("pnpm test && pnpm run build");
    expect(await getPreference(verifyScriptPrefKey("proj-1"), db)).toBe("pnpm test && pnpm run build");
  });

  it("no-ops safely (writes nothing) when detection is empty", async () => {
    const { db } = createTestDb();
    const written = await populateVerifyScript("proj-2", dir, db, profile({ testCommand: null, buildCommand: null }));
    expect(written).toBeNull();
    expect(await getPreference(verifyScriptPrefKey("proj-2"), db)).toBeNull();
  });

  it("does not clobber an existing user override", async () => {
    const { db } = createTestDb();
    await setPreference(verifyScriptPrefKey("proj-3"), "make custom-check", db);
    const written = await populateVerifyScript("proj-3", dir, db, profile({ testCommand: "pnpm test" }));
    expect(written).toBe("make custom-check");
    expect(await getPreference(verifyScriptPrefKey("proj-3"), db)).toBe("make custom-check");
  });

  it("reads the persisted stack profile when none is passed", async () => {
    const { db } = createTestDb();
    // No profile arg and no persisted profile → falls back to marker rules from repoPath.
    await writeFile(join(dir, "go.mod"), "module x\n\ngo 1.22\n");
    const written = await populateVerifyScript("proj-4", dir, db);
    expect(written).toBe("go test ./...");
    expect(await getPreference(verifyScriptPrefKey("proj-4"), db)).toBe("go test ./...");
  });
});
