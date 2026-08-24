import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createPluginService } from "../services/plugin.service.js";
import type { Database } from "../db/index.js";

/**
 * #421 — `getLoopArtifact` used to spawn `git log` AND `git diff` on every open, even
 * though the viewer opens on the Rendered tab and only shows the diff once the reader
 * selects the Diff tab. The file read is sub-millisecond; the git spawns were the whole
 * endpoint (a flat ~65ms regardless of file size, versus 11-15ms for its sibling plugin
 * endpoints).
 *
 * The contract this locks in:
 *   - default open  → `diff: null`, but `hasPreviousVersion` still tells the client
 *     whether a Diff tab is worth offering (that decision needs the cheap `git log`).
 *   - `withDiff`    → the diff is actually computed.
 * Losing `hasPreviousVersion` would make a deferred diff indistinguishable from "this
 * artifact has no previous version", silently removing the Diff tab everywhere.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const MANIFEST = {
  id: "artifact-diff-plugin",
  name: "Artifact Diff Plugin",
  version: "0.1.0",
  skills: [{ dir: "skills/step-runner" }],
  loops: [{ name: "pipeline", skill: "step-runner", plan: { command: "node plan.mjs", cwd: "plugin" } }],
};

function makePluginDir(): string {
  const dir = makeTempDir("ak-artifact-diff-plugin-");
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify(MANIFEST, null, 2));
  const skillDir = join(dir, "skills", "step-runner");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# step-runner\nRun one step.");
  writeFileSync(join(dir, "plan.mjs"), "console.log(JSON.stringify({ units: [] }));");
  return dir;
}

const ARTIFACT_REL = "docs/steps/step-1/report.md";

/** A repo whose artifact has TWO commits, so a v(N-1)→vN diff genuinely exists. */
function makeRepoWithTwoVersions(): string {
  const parent = makeTempDir("ak-artifact-diff-parent-");
  const repo = join(parent, "product-repo");
  mkdirSync(join(repo, "docs", "steps", "step-1"), { recursive: true });
  gitExecSync(["init"], { cwd: repo });
  gitExecSync(["config", "user.email", "test@example.com"], { cwd: repo });
  gitExecSync(["config", "user.name", "Test"], { cwd: repo });

  const abs = join(repo, ARTIFACT_REL);
  writeFileSync(abs, "# Report\n\nversion one\n");
  gitExecSync(["add", "-A"], { cwd: repo });
  gitExecSync(["commit", "-m", "v1"], { cwd: repo });

  writeFileSync(abs, "# Report\n\nversion two\n");
  gitExecSync(["add", "-A"], { cwd: repo });
  gitExecSync(["commit", "-m", "v2"], { cwd: repo });
  return repo;
}

/** A repo whose artifact has exactly ONE commit — no previous version to diff against. */
function makeRepoWithOneVersion(): string {
  const parent = makeTempDir("ak-artifact-diff-parent-");
  const repo = join(parent, "product-repo");
  mkdirSync(join(repo, "docs", "steps", "step-1"), { recursive: true });
  gitExecSync(["init"], { cwd: repo });
  gitExecSync(["config", "user.email", "test@example.com"], { cwd: repo });
  gitExecSync(["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, ARTIFACT_REL), "# Report\n\nonly version\n");
  gitExecSync(["add", "-A"], { cwd: repo });
  gitExecSync(["commit", "-m", "v1"], { cwd: repo });
  return repo;
}

async function insertProject(db: TestDb, repoPath: string): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Artifact Diff Project",
    repoPath,
    repoName: "product-repo",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return projectId;
}

describe("plugin loop artifact — deferred diff (#421)", () => {
  let db: TestDb;
  let service: ReturnType<typeof createPluginService>;

  beforeEach(() => {
    db = createTestDb().db;
    service = createPluginService({ database: db as unknown as Database });
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — temp cleanup is best-effort */
      }
    }
  });

  it("omits the diff by default but still reports that one exists", async () => {
    const plugin = await service.installPlugin({ source: makePluginDir() });
    const projectId = await insertProject(db, makeRepoWithTwoVersions());

    const res = await service.getLoopArtifact(plugin.id, projectId, ARTIFACT_REL);

    expect(res.exists).toBe(true);
    expect(res.content).toContain("version two");
    // The whole point: no diff computed on a plain open...
    expect(res.diff).toBeNull();
    // ...but the client can still tell that a Diff tab is worth offering.
    expect(res.hasPreviousVersion).toBe(true);
    expect(res.commits).toHaveLength(2);
  });

  it("computes the diff when withDiff is requested", async () => {
    const plugin = await service.installPlugin({ source: makePluginDir() });
    const projectId = await insertProject(db, makeRepoWithTwoVersions());

    const res = await service.getLoopArtifact(plugin.id, projectId, ARTIFACT_REL, { withDiff: true });

    expect(res.hasPreviousVersion).toBe(true);
    expect(res.diff).toBeTruthy();
    // Assert on keywords, not exact strings — CRLF vs LF and git's hunk headers vary.
    expect(res.diff).toContain("version two");
    expect(res.diff).toContain("version one");
  });

  it("reports no previous version for a single-commit artifact, with or without withDiff", async () => {
    const plugin = await service.installPlugin({ source: makePluginDir() });
    const projectId = await insertProject(db, makeRepoWithOneVersion());

    for (const opts of [undefined, { withDiff: true }]) {
      const res = await service.getLoopArtifact(plugin.id, projectId, ARTIFACT_REL, opts);
      expect(res.hasPreviousVersion).toBe(false);
      expect(res.diff).toBeNull();
      expect(res.commits).toHaveLength(1);
    }
  });

  it("returns a not-produced-yet shape for a declared artifact that does not exist", async () => {
    const plugin = await service.installPlugin({ source: makePluginDir() });
    const projectId = await insertProject(db, makeRepoWithOneVersion());

    const res = await service.getLoopArtifact(plugin.id, projectId, "docs/steps/step-9/never_written.md");

    expect(res.exists).toBe(false);
    expect(res.content).toBeNull();
    expect(res.hasPreviousVersion).toBe(false);
  });
});
