import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createPluginService, stopAllPluginViews } from "../services/plugin.service.js";
import type { Database } from "../db/index.js";

const EM_DASH_TITLE = "Requirement extraction: auth-service — round 1";
const EM_DASH_DESC = "The observed UI navigation graph — which pages link where.";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("plugin manifest / loop-plan UTF-8 repro", () => {
  let db: TestDb;
  let service: ReturnType<typeof createPluginService>;

  beforeEach(() => {
    db = createTestDb().db;
  });

  afterEach(() => {
    stopAllPluginViews();
    for (const dir of tempDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("manifest description with an em-dash round-trips through install + listPlugins", async () => {
    const dir = makeTempDir("plugin-encoding-test-");
    writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify({
      id: "enc-test",
      name: "Encoding Test",
      description: EM_DASH_DESC,
    }, null, 2));

    service = createPluginService({ database: db as unknown as Database });
    await service.installPlugin({ source: dir });
    const listed = await service.listPlugins();
    expect(listed[0].manifest?.description).toBe(EM_DASH_DESC);
  });

  it("loop plan stdout with an em-dash in the title becomes an issue title with no mojibake", async () => {
    const pluginDir = makeTempDir("plugin-encoding-loop-");
    writeFileSync(join(pluginDir, "kanban-plugin.json"), JSON.stringify({
      id: "enc-loop-test",
      name: "Encoding Loop Test",
      skills: [{ dir: "skills/x" }],
      loops: [{ name: "extract", skill: "x", plan: { command: "node plan.mjs", cwd: "plugin" } }],
    }, null, 2));
    mkdirSync(join(pluginDir, "skills", "x"), { recursive: true });
    writeFileSync(join(pluginDir, "skills", "x", "SKILL.md"), "# x");
    writeFileSync(
      join(pluginDir, "plan.mjs"),
      `console.log(JSON.stringify({ units: [{ id: "r1", title: ${JSON.stringify(EM_DASH_TITLE)} }] }));`,
    );

    const projectRepo = makeTempDir("plugin-encoding-repo-");
    gitExecSync(["init"], { cwd: projectRepo });
    const projectId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.projects).values({
      id: projectId,
      name: "Encoding Project",
      repoPath: projectRepo,
      repoName: "encoding-project",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });

    let createdTitle: string | null = null;
    service = createPluginService({
      database: db as unknown as Database,
      createIssue: async (input) => {
        createdTitle = input.title;
        return { id: randomUUID(), issueNumber: 1 } as any;
      },
    } as any);

    const row = await service.installPlugin({ source: pluginDir });
    const result = await service.advanceLoop(row.id, "extract", projectId);
    expect(result.created).toHaveLength(1);
    expect(createdTitle).toBe(EM_DASH_TITLE);
  });
});
