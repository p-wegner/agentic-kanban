import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { pluginLoopUnitKey } from "@agentic-kanban/shared/lib/plugin-manifest";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createPluginService } from "../services/plugin.service.js";
import type { Database } from "../db/index.js";
import type { CreateIssueInput, CreateIssueResult } from "../services/issue.service.js";

/**
 * #249 — two overlapping advances of ONE loop must produce ONE ticket set.
 *
 * The dedupe is read-then-create with no unique index behind it, and the planner sits in the
 * middle of that window (here: a deliberate delay, in reality up to two minutes). The monitor's
 * loop phase and the manual "Advance now" route are genuinely concurrent callers.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const MANIFEST = {
  id: "race-plugin",
  name: "Race Plugin",
  version: "0.1.0",
  skills: [{ dir: "skills/analysis" }],
  loops: [
    {
      name: "sweep",
      skill: "analysis",
      plan: { command: "node plan.mjs", cwd: "plugin", env: { PLAN_LOG: "{{pluginPath}}/plan-log.txt" } },
    },
  ],
};

function makePluginDir(): string {
  const dir = makeTempDir("loop-race-plugin-");
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify(MANIFEST, null, 2));
  const skillDir = join(dir, "skills", "analysis");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# analysis");
  // A slow planner that RECORDS its own window. Two overlapping windows in the log prove the
  // advances ran concurrently — which is the actual defect; whether the concurrent run happens
  // to duplicate a ticket depends on subprocess-spawn jitter and would make a flaky assertion.
  writeFileSync(
    join(dir, "plan.mjs"),
    "import { appendFileSync } from 'node:fs';\n"
      + "const start = Date.now();\n"
      + "await new Promise((r) => setTimeout(r, 400));\n"
      + "appendFileSync(process.env.PLAN_LOG, `${start},${Date.now()}\\n`);\n"
      + "console.log(JSON.stringify({ units: ["
      + "{ id: 'alpha', title: 'Alpha' }, { id: 'beta', title: 'Beta' }"
      + "], converged: false }));\n",
  );
  return dir;
}

async function insertProject(db: TestDb, repoPath: string): Promise<{ projectId: string; statusId: string }> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Race Project",
    repoPath,
    repoName: "race-project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "Backlog",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });
  return { projectId, statusId };
}

describe("plugin loop advance — concurrency (#249)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — best-effort cleanup */
      }
    }
  });

  it("two concurrent advances of one loop create ONE ticket set", async () => {
    const { db } = createTestDb();
    const repo = makeTempDir("loop-race-repo-");
    const { projectId, statusId } = await insertProject(db, repo);

    let issueNumber = 0;
    const createIssue = async (input: CreateIssueInput): Promise<CreateIssueResult> => {
      const now = new Date().toISOString();
      const id = randomUUID();
      issueNumber += 1;
      await db.insert(schema.issues).values({
        id,
        title: input.title,
        description: input.description ?? null,
        priority: "medium",
        sortOrder: 0,
        statusId,
        projectId,
        issueNumber,
        externalKey: input.externalKey ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { id, issueNumber } as CreateIssueResult;
    };

    const service = createPluginService({ database: db as unknown as Database, createIssue });
    const pluginDir = makePluginDir();
    const plugin = await service.installPlugin({ source: pluginDir });

    const [first, second] = await Promise.all([
      service.advanceLoop(plugin.id, "sweep", projectId),
      service.advanceLoop(plugin.id, "sweep", projectId),
    ]);

    // Exactly one ticket per unit exists in the DB — no duplicate external keys.
    const rows = await db.select().from(schema.issues).where(eq(schema.issues.projectId, projectId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.externalKey).sort()).toEqual([
      pluginLoopUnitKey("race-plugin", "sweep", "alpha"),
      pluginLoopUnitKey("race-plugin", "sweep", "beta"),
    ]);

    // One caller created them; the other saw them as already ticketed.
    const createdCounts = [first.created.length, second.created.length].sort();
    expect(createdCounts).toEqual([0, 2]);
    const skippedCounts = [first.skippedExisting.length, second.skippedExisting.length].sort();
    expect(skippedCounts).toEqual([0, 2]);

    // …and they got there by being SERIALIZED: the two planner windows must not overlap. This is
    // the assertion that fails without the per-loop lock, independent of spawn jitter.
    const windows = readFileSync(join(pluginDir, "plan-log.txt"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split(",").map(Number))
      .sort((a, b) => a[0] - b[0]);
    expect(windows).toHaveLength(2);
    expect(windows[1][0]).toBeGreaterThanOrEqual(windows[0][1]);
  });
});
