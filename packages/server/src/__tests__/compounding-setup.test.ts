import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";

import {
  DEFAULT_MIN_MERGES,
  PASS_VERSION,
  compoundingSetupStatePrefKey,
  isPassUpToDate,
  maybeRunCompoundingSetup,
  readCompoundingSetupState,
  resolveCompoundingSetupGate,
} from "../services/compounding-setup.service.js";
import { buildDomainMap, collectDomainMapEntries, DOMAIN_MAP_PATH } from "../services/compounding-setup/domain-map.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

const NOW = "2026-07-20T10:00:00.000Z";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "compounding-setup-"));
}

function makeRepo(): string {
  const dir = makeDir();
  gitExecSync(["init", "-b", "master"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
  gitExecSync(["config", "user.email", "test@example.com"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
  gitExecSync(["config", "user.name", "Test"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
  return dir;
}

async function seedProject(database: TestDb, repoPath: string) {
  const projectId = randomUUID();
  await database.insert(projects).values({
    id: projectId,
    name: "Compounding Project",
    repoPath,
    repoName: "compounding",
    defaultBranch: "master",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const statusId = randomUUID();
  await database.insert(projectStatuses).values({
    id: statusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: NOW,
  });
  return { projectId, statusId };
}

/** Insert an issue plus a workspace, merged or not — merged workspaces are the trigger signal. */
async function seedWorkspace(
  database: TestDb,
  input: { projectId: string; statusId: string; issueNumber: number; merged: boolean },
) {
  const issueId = randomUUID();
  await database.insert(issues).values({
    id: issueId,
    projectId: input.projectId,
    statusId: input.statusId,
    issueNumber: input.issueNumber,
    title: `Issue ${input.issueNumber}`,
    description: "",
    priority: "medium",
    issueType: "task",
    sortOrder: input.issueNumber,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await database.insert(workspaces).values({
    id: randomUUID(),
    issueId,
    branch: `feature/ak-${input.issueNumber}`,
    status: input.merged ? "closed" : "active",
    mergedAt: input.merged ? NOW : null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function seedMergedWorkspaces(database: TestDb, projectId: string, statusId: string, count: number) {
  for (let i = 1; i <= count; i++) {
    await seedWorkspace(database, { projectId, statusId, issueNumber: i, merged: true });
  }
}

describe("resolveCompoundingSetupGate", () => {
  const projectId = "11111111-1111-1111-1111-111111111111";
  const key = `compounding_setup_${projectId}`;

  it("is enabled at the board-wide threshold when the project has no override", () => {
    expect(resolveCompoundingSetupGate(new Map(), projectId, 5)).toEqual({ enabled: true, threshold: 5 });
  });

  it("is disabled by an explicit off/false/0", () => {
    for (const value of ["off", "OFF", "false", "0", " off "]) {
      expect(resolveCompoundingSetupGate(new Map([[key, value]]), projectId, 5).enabled).toBe(false);
    }
  });

  it("takes a numeric per-project threshold override", () => {
    expect(resolveCompoundingSetupGate(new Map([[key, "12"]]), projectId, 5)).toEqual({ enabled: true, threshold: 12 });
  });

  it("is disabled board-wide when the default threshold is 0", () => {
    expect(resolveCompoundingSetupGate(new Map(), projectId, 0).enabled).toBe(false);
  });

  it("ignores an unparseable value and falls back to the board-wide default", () => {
    expect(resolveCompoundingSetupGate(new Map([[key, "later"]]), projectId, 5)).toEqual({ enabled: true, threshold: 5 });
  });
});

describe("isPassUpToDate", () => {
  it("treats a never-run project as due", () => {
    expect(isPassUpToDate(null)).toBe(false);
  });

  it("treats an older pass version as due again, so improvements back-fill", () => {
    expect(isPassUpToDate({ version: PASS_VERSION - 1, ranAt: NOW, mergedCount: 9, artifacts: [] })).toBe(false);
  });

  it("treats the current version as done", () => {
    expect(isPassUpToDate({ version: PASS_VERSION, ranAt: NOW, mergedCount: 9, artifacts: [] })).toBe(true);
  });
});

describe("buildDomainMap", () => {
  const base = {
    projectName: "Demo",
    entries: [{ path: "src/services", childCount: 12 }, { path: "src", childCount: 3 }],
    harnessFiles: [".claude/smart-hooks-rules.json"],
    generatedAt: NOW,
  };

  it("renders the detected commands and layout", () => {
    const md = buildDomainMap({
      ...base,
      profile: {
        stack: "node", packageManager: "pnpm", isMonorepo: false, workspaces: [],
        installCommand: "pnpm install", buildCommand: "pnpm build", testCommand: "pnpm test",
        quickTestCommand: "pnpm test:mine", lintCommand: null, typecheckCommand: "pnpm typecheck",
        devCommand: null, isWeb: false, devHealthUrl: null, devPort: null,
        testDir: "src/__tests__", testRunner: "vitest",
        source: "detected", detectedMarkers: ["package.json"], updatedAt: NOW,
      },
    });
    expect(md).toContain("# Domain map — Demo");
    expect(md).toContain("`pnpm test:mine`");
    expect(md).toContain("`src/services`");
    expect(md).toContain("vitest");
    expect(md).toContain(".claude/smart-hooks-rules.json");
    // A command the profile doesn't have must not be invented.
    expect(md).not.toContain("**Lint:**");
  });

  it("degrades honestly with no profile and no source dirs", () => {
    const md = buildDomainMap({ ...base, profile: null, entries: [], harnessFiles: [] });
    expect(md).toContain("No stack profile detected yet");
    expect(md).toContain("No source directories detected");
    expect(md).not.toContain("## Harness you inherit");
  });
});

describe("collectDomainMapEntries", () => {
  it("reports source directories by density and skips noise dirs", () => {
    const repo = makeDir();
    mkdirSync(join(repo, "src", "services"), { recursive: true });
    mkdirSync(join(repo, "node_modules", "junk"), { recursive: true });
    writeFileSync(join(repo, "src", "index.ts"), "export {};\n");
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      writeFileSync(join(repo, "src", "services", name), "export {};\n");
    }
    writeFileSync(join(repo, "node_modules", "junk", "dep.js"), "module.exports={};\n");
    writeFileSync(join(repo, "README.md"), "# readme\n");

    const entries = collectDomainMapEntries(repo);
    expect(entries[0]).toEqual({ path: "src/services", childCount: 3 });
    expect(entries.map((e) => e.path)).toContain("src");
    expect(entries.some((e) => e.path.includes("node_modules"))).toBe(false);
  });
});

describe("maybeRunCompoundingSetup", () => {
  // ONE migrated database for the whole suite — applying every migration costs tens of
  // seconds here, and each test already isolates itself behind its own project id and
  // its own temp repo, so a per-test DB would buy nothing but wall-clock.
  let db: TestDb;
  beforeAll(() => {
    db = createTestDb().db;
  });

  it("does nothing until the project has enough merged work", async () => {
    const repo = makeRepo();
    const { projectId, statusId } = await seedProject(db, repo);
    await seedMergedWorkspaces(db, projectId, statusId, DEFAULT_MIN_MERGES - 1);

    const result = await maybeRunCompoundingSetup(projectId, { enabled: true, threshold: DEFAULT_MIN_MERGES }, db);

    expect(result.ran).toBe(false);
    expect(result.reason).toBe("not_enough_merges");
    expect(result.mergedCount).toBe(DEFAULT_MIN_MERGES - 1);
    expect(existsSync(join(repo, ...DOMAIN_MAP_PATH.split("/")))).toBe(false);
  });

  it("does not count unmerged workspaces toward the threshold", async () => {
    const repo = makeRepo();
    const { projectId, statusId } = await seedProject(db, repo);
    for (let i = 1; i <= DEFAULT_MIN_MERGES + 3; i++) {
      await seedWorkspace(db, { projectId, statusId, issueNumber: i, merged: false });
    }

    const result = await maybeRunCompoundingSetup(projectId, { enabled: true, threshold: DEFAULT_MIN_MERGES }, db);

    expect(result.mergedCount).toBe(0);
    expect(result.ran).toBe(false);
  });

  it("scaffolds the harness and a domain map once the threshold is reached", async () => {
    const repo = makeRepo();
    const { projectId, statusId } = await seedProject(db, repo);
    await seedMergedWorkspaces(db, projectId, statusId, DEFAULT_MIN_MERGES);

    const result = await maybeRunCompoundingSetup(projectId, { enabled: true, threshold: DEFAULT_MIN_MERGES }, db);

    expect(result.ran).toBe(true);
    expect(existsSync(join(repo, ".claude", "hooks", "vital-file-guard.js"))).toBe(true);
    expect(existsSync(join(repo, ".claude", "hooks", "verify-gate-runner.js"))).toBe(true);

    const mapPath = join(repo, ...DOMAIN_MAP_PATH.split("/"));
    expect(existsSync(mapPath)).toBe(true);
    expect(readFileSync(mapPath, "utf8")).toContain("# Domain map — Compounding Project");

    const state = await readCompoundingSetupState(projectId, db);
    expect(state?.version).toBe(PASS_VERSION);
    expect(state?.mergedCount).toBe(DEFAULT_MIN_MERGES);
    expect(state?.artifacts).toContain(DOMAIN_MAP_PATH);
  });

  it("runs ONCE — a second cycle is a no-op, not a re-scaffold", async () => {
    const repo = makeRepo();
    const { projectId, statusId } = await seedProject(db, repo);
    await seedMergedWorkspaces(db, projectId, statusId, DEFAULT_MIN_MERGES);
    const gate = { enabled: true, threshold: DEFAULT_MIN_MERGES };

    expect((await maybeRunCompoundingSetup(projectId, gate, db)).ran).toBe(true);
    const second = await maybeRunCompoundingSetup(projectId, gate, db);

    expect(second.ran).toBe(false);
    expect(second.reason).toBe("already_ran");
  });

  it("re-runs when the pass version has moved on, so improvements back-fill", async () => {
    const repo = makeRepo();
    const { projectId, statusId } = await seedProject(db, repo);
    await seedMergedWorkspaces(db, projectId, statusId, DEFAULT_MIN_MERGES);
    const gate = { enabled: true, threshold: DEFAULT_MIN_MERGES };

    expect((await maybeRunCompoundingSetup(projectId, gate, db)).ran).toBe(true);
    // Simulate a project set up by an OLDER pass.
    const { setPreference } = await import("../repositories/preferences.repository.js");
    await setPreference(
      compoundingSetupStatePrefKey(projectId),
      JSON.stringify({ version: PASS_VERSION - 1, ranAt: NOW, mergedCount: 5, artifacts: [] }),
      db,
    );

    expect((await maybeRunCompoundingSetup(projectId, gate, db)).ran).toBe(true);
  });

  it("respects a disabled gate even when the project is well past the threshold", async () => {
    const repo = makeRepo();
    const { projectId, statusId } = await seedProject(db, repo);
    await seedMergedWorkspaces(db, projectId, statusId, DEFAULT_MIN_MERGES + 5);

    const result = await maybeRunCompoundingSetup(projectId, { enabled: false, threshold: DEFAULT_MIN_MERGES }, db);

    expect(result.ran).toBe(false);
    expect(result.reason).toBe("disabled");
    expect(existsSync(join(repo, ".claude"))).toBe(false);
  });

  it("commits its artifacts so worktrees forked later actually inherit them", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "README.md"), "# repo\n");
    gitExecSync(["add", "-A"], { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
    gitExecSync(["commit", "-m", "init"], { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });

    const { projectId, statusId } = await seedProject(db, repo);
    await seedMergedWorkspaces(db, projectId, statusId, DEFAULT_MIN_MERGES);
    await maybeRunCompoundingSetup(projectId, { enabled: true, threshold: DEFAULT_MIN_MERGES }, db);

    const tracked = gitExecSync(["ls-files", "--", ".claude"], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });
    expect(tracked).toContain(DOMAIN_MAP_PATH);
  });
});
