import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createPluginService, stopAllPluginViewsAsync } from "../services/plugin.service.js";
import type { Database } from "../db/index.js";

/**
 * #456 — the capability rail listed a plugin selftest and a dry-run planner dump at the same
 * weight as the loop that IS the workflow. A manifest can now mark an entry
 * `audience: "developer"`; the surface is where that reaches the rail, and it must arrive
 * RESOLVED — an entry that says nothing is `operator`, so a manifest written before the field
 * existed renders exactly as it did.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const MANIFEST = {
  id: "audience-probe",
  name: "Audience Probe",
  version: "0.1.0",
  skills: [
    { dir: "skills/operate", description: "The workflow skill." },
    { dir: "skills/step-runner", description: "What the loop launches.", audience: "developer" as const },
  ],
  scripts: [
    { name: "status", command: "node -e \"\"", cwd: "plugin" as const },
    { name: "selftest", command: "node -e \"\"", cwd: "plugin" as const, audience: "developer" as const },
  ],
};

function makePluginDir(): string {
  const dir = makeTempDir("audience-plugin-");
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify(MANIFEST, null, 2));
  for (const name of ["operate", "step-runner"]) {
    const skillDir = join(dir, "skills", name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `# ${name}\n`);
  }
  return dir;
}

function makeProjectRepo(): string {
  const parent = makeTempDir("audience-parent-");
  const repo = join(parent, "product-repo");
  mkdirSync(repo, { recursive: true });
  gitExecSync(["init"], { cwd: repo });
  return repo;
}

async function insertProject(db: TestDb, repoPath: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.projects).values({
    id,
    name: "audience-project",
    repoPath,
    repoName: "audience-project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("plugin surface — entry audience (#456)", () => {
  let db: TestDb;
  let service: ReturnType<typeof createPluginService>;

  beforeEach(() => {
    db = createTestDb().db;
    service = createPluginService({ database: db as unknown as Database });
  });

  afterEach(async () => {
    await stopAllPluginViewsAsync();
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — temp cleanup is best-effort */
      }
    }
  });

  it("carries each entry's audience through, defaulting an unmarked one to operator", async () => {
    const pluginDir = makePluginDir();
    const projectId = await insertProject(db, makeProjectRepo());
    const plugin = await service.installPlugin({ source: pluginDir });
    await service.enableForProject(plugin.id, projectId);

    const surface = await service.listProjectSurface(projectId);
    const scripts = Object.fromEntries(surface.scripts.map((s) => [s.name, s.audience]));
    const skills = Object.fromEntries(surface.skills.map((s) => [s.name, s.audience]));

    expect(scripts).toEqual({ status: "operator", selftest: "developer" });
    expect(skills).toEqual({ operate: "operator", "step-runner": "developer" });
  });
});
