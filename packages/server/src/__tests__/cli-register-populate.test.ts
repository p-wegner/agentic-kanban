import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { projects } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { verifyScriptPrefKey, getStackProfile } from "../services/stack-profile.service.js";
// Moved from cli/commands/register.ts into the shared registration service by #43 — the CLI,
// REST and init paths now all call this ONE implementation.
import { populateDerivedProjectConfig } from "../services/project-registration.js";

/**
 * Regression for #37: `pnpm cli -- register <path>` used to call insertProject() directly and
 * never populate the stack profile / verify script / setup script that the service path
 * (`registerProject()`) derives — so a CLI-registered project had setup_script = null forever,
 * no deps were installed in the first worktree, and the merge gate was silently absent.
 */
async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kanban-cli-register-"));
}

/** Insert a bare project row, as the CLI's insertProject() would have just done. */
async function seedProject(
  db: ReturnType<typeof createTestDb>["db"],
  repoPath: string,
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(projects).values({
    id, name: "p", repoPath, repoName: "p", setupScript: null, createdAt: now, updatedAt: now,
  });
  return id;
}

describe("populateDerivedProjectConfig (CLI register)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tmp();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A plain npm Node repo. test+build scripts keep the profile non-sparse (no LLM gap-fill). */
  async function writeNodeRepo(): Promise<void> {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "toy", dependencies: { pg: "^8.11.0" },
        scripts: { test: "node --test", build: "tsc" },
      }),
    );
  }

  it("persists a non-null setup_script for a Node project with a package.json", async () => {
    const { db } = createTestDb();
    await writeNodeRepo();
    const id = await seedProject(db, dir);

    const { setupScript } = await populateDerivedProjectConfig(id, dir, db);

    expect(setupScript).toBe("npm install");
    const [row] = await db.select({ s: projects.setupScript }).from(projects).where(eq(projects.id, id));
    expect(row.s).toBe("npm install");
  });

  it("persists the verify (merge-gate) command pref", async () => {
    const { db } = createTestDb();
    await writeNodeRepo();
    const id = await seedProject(db, dir);

    const { verifyScript } = await populateDerivedProjectConfig(id, dir, db);

    expect(verifyScript).toBeTruthy();
    const pref = await getPreference(verifyScriptPrefKey(id), db);
    expect(pref).toBeTruthy();
    expect(pref).toContain("npm test");
  });

  it("persists the stack profile", async () => {
    const { db } = createTestDb();
    await writeNodeRepo();
    const id = await seedProject(db, dir);

    await populateDerivedProjectConfig(id, dir, db);

    const profile = await getStackProfile(id, db);
    expect(profile?.stack).toBe("node");
    expect(profile?.packageManager).toBe("npm");
    expect(profile?.installCommand).toBe("npm install");
  });

  it("does not clobber an already-configured setup script", async () => {
    const { db } = createTestDb();
    await writeNodeRepo();
    const id = await seedProject(db, dir);
    await db.update(projects).set({ setupScript: "make bootstrap" }).where(eq(projects.id, id));

    const { setupScript } = await populateDerivedProjectConfig(id, dir, db);

    expect(setupScript).toBe("make bootstrap");
    const [row] = await db.select({ s: projects.setupScript }).from(projects).where(eq(projects.id, id));
    expect(row.s).toBe("make bootstrap");
  });

  it("is non-fatal for an undetectable repo (registration must still succeed)", async () => {
    const { db } = createTestDb();
    const id = await seedProject(db, dir); // empty dir — no markers at all

    // skipLlm: a marker-less repo is "sparse", which would otherwise fire a real
    // invokeClaudePrompt gap-fill. Rule-based-only keeps this test hermetic.
    const result = await populateDerivedProjectConfig(id, dir, db, { skipLlm: true });

    expect(result.setupScript).toBeNull();
    const [row] = await db.select({ s: projects.setupScript }).from(projects).where(eq(projects.id, id));
    expect(row.s).toBeNull();
  });
});
