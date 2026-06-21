/**
 * Focused tests for the stack detector at its own home after the #853 god-file split
 * (detectStackProfile + the Gradle/KMP/Ktor/Node/Python detectors were extracted from
 * stack-profile.service into stack-detector.service). Imports directly from the new
 * module to prove it stands alone; the comprehensive matrix lives in
 * stack-profile.service.test.ts (which exercises the re-export).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectStackProfile } from "../services/stack-detector.service.js";

describe("stack-detector.service detectStackProfile", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "kanban-detector-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("detects a Node pnpm project", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest", build: "tsc" } }));
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const p = detectStackProfile(dir);
    expect(p.stack).toBe("node");
    expect(p.packageManager).toBe("pnpm");
    expect(p.installCommand).toBe("pnpm install");
    expect(p.source).toBe("detected");
  });

  it("detects a Gradle/Java multi-module project", async () => {
    await writeFile(join(dir, "build.gradle"), "plugins { id 'java' }\n");
    await writeFile(join(dir, "settings.gradle"), "include 'app', 'lib'\n");
    const p = detectStackProfile(dir);
    expect(p.stack).toBe("java");
    expect(p.isMonorepo).toBe(true);
    expect(p.installCommand).toBe("gradle assemble");
  });

  it("detects a Kotlin Multiplatform project (commonTest, not web)", async () => {
    await writeFile(join(dir, "build.gradle.kts"), `plugins { kotlin("multiplatform") version "2.0.21" }\n`);
    await mkdir(join(dir, "src", "commonTest", "kotlin"), { recursive: true });
    const p = detectStackProfile(dir);
    expect(p.stack).toBe("java");
    expect(p.isWeb).toBe(false);
    expect(p.testDir).toBe("src/commonTest/kotlin");
  });

  it("detects a Ktor server (kotlin-jvm + application + ktor dep) as web", async () => {
    await writeFile(
      join(dir, "build.gradle.kts"),
      `plugins { kotlin("jvm") version "2.0.21"; application }\ndependencies { implementation("io.ktor:ktor-server-netty:2.3.12") }\n`,
    );
    const p = detectStackProfile(dir);
    expect(p.stack).toBe("java");
    expect(p.isWeb).toBe(true);
    expect(p.typecheckCommand).toContain("compileKotlin");
  });

  it("detects a Python project from requirements.txt", async () => {
    await writeFile(join(dir, "requirements.txt"), "pytest\n");
    const p = detectStackProfile(dir);
    expect(p.stack).toBe("python");
    expect(p.testCommand).toBe("python -m pytest");
  });

  it("returns a sparse 'detected' profile (stack null) for an unknown/empty repo", async () => {
    const p = detectStackProfile(dir);
    expect(p.stack).toBeNull();
    expect(p.source).toBe("detected");
    expect(Array.isArray(p.detectedMarkers)).toBe(true);
  });
});
