// #964 — relocating a project must rewrite EVERY persisted path that pointed at the old
// checkout, not just `projects.repo_path`. The bug this guards against is the one that made
// hand-editing the DB the usual remedy: a project whose repo_path moved while its
// workspaces' working_dir, its repos rows and the projects_base_path preference still
// named a directory that is no longer there.
//
// The disk half (rename + `git worktree repair`) is exercised against a REAL git repo with
// a REAL worktree, because that is the part where a plausible-looking implementation
// (rename the directory, update the row) leaves git broken in both directions.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { applyMigrationsToClient } from "./helpers/test-db.js";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const h = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  db: undefined as TestDb | undefined,
}));

function liveProxy<T extends object>(getCurrent: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const current = getCurrent() as Record<PropertyKey, unknown>;
      const value = current[prop];
      return typeof value === "function" ? value.bind(current) : value;
    },
  });
}

vi.mock("../db/index.js", () => {
  const db = liveProxy<TestDb>(() => h.db!);
  const client = liveProxy<Client>(() => h.client!);
  return {
    db,
    writeDb: db,
    rawClient: client,
    rawWriteClient: client,
    schema,
    withDbRetry: <T>(fn: () => Promise<T>) => fn(),
    withTransaction: <T>(database: TestDb, fn: (tx: unknown) => Promise<T>) => database.transaction(fn),
  };
});

const { planProjectRelocation, relocateProject, relocateProjectsUnderPrefix } = await import(
  "../services/project-relocate.service.js"
);

let sandbox: string;
let dbFile: string;

function tempDir(label: string): string {
  const dir = join(sandbox, `${label}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function seedProject(name: string, repoPath: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await h.db!.insert(schema.projects).values({
    id,
    name,
    repoPath,
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  await h.db!.insert(schema.projectStatuses).values({
    id: randomUUID(),
    projectId: id,
    name: "Backlog",
    sortOrder: 0,
  });
  return id;
}

/** A workspace with a worktree. The project link runs through the workspace's issue. */
async function seedWorkspace(projectId: string, workingDir: string, status = "idle"): Promise<string> {
  const [statusRow] = await h.db!
    .select()
    .from(schema.projectStatuses)
    .where(eq(schema.projectStatuses.projectId, projectId));
  const now = new Date().toISOString();
  const issueId = randomUUID();
  await h.db!.insert(schema.issues).values({
    id: issueId,
    projectId,
    statusId: statusRow!.id,
    issueNumber: 1,
    title: "t",
    createdAt: now,
    updatedAt: now,
  });
  const workspaceId = randomUUID();
  await h.db!.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-1-t",
    workingDir,
    status,
    createdAt: now,
    updatedAt: now,
  });
  return workspaceId;
}

beforeEach(() => {
  sandbox = join(tmpdir(), `ak-relocate-${randomUUID().slice(0, 8)}`);
  mkdirSync(sandbox, { recursive: true });
  // File-backed, not `:memory:`: libsql opens a SEPARATE connection for a transaction,
  // and a second connection to `:memory:` is a second, empty database — so every write
  // through `withTransaction` would fail with "no such table".
  dbFile = join(sandbox, `relocate-${randomUUID().slice(0, 8)}.db`);
  const client = createClient({ url: `file:${dbFile}` });
  applyMigrationsToClient(client);
  client.execute("PRAGMA foreign_keys=ON");
  h.client = client;
  h.db = drizzle(client, { schema });
});

afterEach(() => {
  h.client?.close();
  h.client = undefined;
  h.db = undefined;
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // A worktree Windows still holds open is not this test's failure.
  }
});

describe("planProjectRelocation (#964)", () => {
  it("names every persisted path it would rewrite, and rewrites none of them", async () => {
    const oldParent = tempDir("oldparent");
    const from = join(oldParent, "app");
    mkdirSync(from, { recursive: true });
    const projectId = await seedProject("p", from);
    // The worktree lives BESIDE the repo, not inside it — the case a naive
    // "rewrite anything under repoPath" implementation strands.
    const worktree = join(oldParent, ".worktrees", "ak-1");
    await seedWorkspace(projectId, worktree);
    await h.db!.insert(schema.preferences).values({ key: "projects_base_path", value: oldParent });

    const newParent = join(sandbox, "newparent");
    const plan = await planProjectRelocation(projectId, join(newParent, "app"), { moveFiles: true });

    expect(plan.changes.map((c) => `${c.table}.${c.column}`).sort()).toEqual([
      "preferences.value",
      "projects.repo_path",
      "workspaces.working_dir",
    ]);
    expect(plan.changes.find((c) => c.table === "workspaces")!.to).toBe(join(newParent, ".worktrees", "ak-1"));
    expect(plan.changes.find((c) => c.table === "preferences")!.to).toBe(newParent);
    expect(plan.blockers).toEqual([]);

    const [row] = await h.db!.select().from(schema.projects).where(eq(schema.projects.id, projectId));
    expect(row!.repoPath).toBe(from);
  });

  it("blocks a relocation while one of the project's agents is running", async () => {
    const from = tempDir("old");
    const projectId = await seedProject("p", from);
    await seedWorkspace(projectId, join(sandbox, ".worktrees", "ak-1"), "active");

    const plan = await planProjectRelocation(projectId, join(sandbox, "moved"), { moveFiles: true });
    expect(plan.blockers.some((b) => b.includes("running agent"))).toBe(true);

    const forced = await planProjectRelocation(projectId, join(sandbox, "moved"), {
      moveFiles: true,
      force: true,
    });
    expect(forced.blockers).toEqual([]);
  });

  it("blocks a destination that is not a git checkout when it is not doing the move itself", async () => {
    const from = tempDir("old");
    const projectId = await seedProject("p", from);

    const plan = await planProjectRelocation(projectId, join(sandbox, "nowhere"), {});
    expect(plan.blockers.some((b) => b.includes("not a git checkout"))).toBe(true);
  });

  it("refuses to relocate a project into itself", async () => {
    const from = tempDir("old");
    const projectId = await seedProject("p", from);

    const plan = await planProjectRelocation(projectId, join(from, "nested"), { moveFiles: true });
    expect(plan.blockers.some((b) => b.includes("into or out of itself"))).toBe(true);
  });
});

describe("relocateProject (#964)", () => {
  it("dryRun applies nothing", async () => {
    const from = tempDir("old");
    const projectId = await seedProject("p", from);

    const result = await relocateProject(projectId, join(sandbox, "moved"), { moveFiles: true, dryRun: true });
    expect(result.applied).toBe(false);
    expect(existsSync(from)).toBe(true);
    const [row] = await h.db!.select().from(schema.projects).where(eq(schema.projects.id, projectId));
    expect(row!.repoPath).toBe(from);
  });

  it("moves a real repo with a real worktree and relinks git in BOTH directions", async () => {
    const parent = tempDir("parent");
    const repo = join(parent, "app");
    mkdirSync(repo, { recursive: true });
    await gitExec(["init", "-b", "master"], { cwd: repo });
    await gitExec(["config", "user.email", "t@example.com"], { cwd: repo });
    await gitExec(["config", "user.name", "t"], { cwd: repo });
    await gitExec(["commit", "--allow-empty", "-m", "init"], { cwd: repo });
    const worktree = join(parent, ".worktrees", "ak-1");
    await gitExec(["worktree", "add", "-b", "feature/ak-1-t", worktree], { cwd: repo });

    const projectId = await seedProject("app", repo);
    const workspaceId = await seedWorkspace(projectId, worktree);

    const newParent = tempDir("newparent");
    const target = join(newParent, "app");
    const result = await relocateProject(projectId, target, { moveFiles: true });

    expect(result.blockers).toEqual([]);
    expect(result.applied).toBe(true);
    expect(existsSync(join(target, ".git"))).toBe(true);
    expect(existsSync(repo)).toBe(false);

    const movedWorktree = join(newParent, ".worktrees", "ak-1");
    expect(existsSync(movedWorktree)).toBe(true);

    const [project] = await h.db!.select().from(schema.projects).where(eq(schema.projects.id, projectId));
    expect(project!.repoPath).toBe(target);
    const [workspace] = await h.db!
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
    expect(workspace!.workingDir).toBe(movedWorktree);

    // Both directions of the git link: the repo lists the worktree at its new path, and
    // the worktree itself can answer a git question rather than erroring on a dead gitdir.
    expect(result.worktreeRepairs[0]!.ok).toBe(true);
    const listed = await gitExec(["worktree", "list"], { cwd: target });
    expect(listed.stdout.replace(/\\/g, "/").toLowerCase()).toContain(
      movedWorktree.replace(/\\/g, "/").toLowerCase(),
    );
    const branch = await gitExec(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: movedWorktree });
    expect(branch.stdout.trim()).toBe("feature/ak-1-t");
  });
});

describe("relocateProjectsUnderPrefix (#964)", () => {
  it("relocates every project under the prefix and leaves neighbours alone", async () => {
    const oldRoot = tempDir("oldroot");
    const newRoot = join(sandbox, "newroot");
    const a = join(oldRoot, "a");
    const b = join(oldRoot, "b");
    // A sibling directory whose name STARTS with the prefix but is not under it.
    const decoy = `${oldRoot}-baseline`;
    for (const dir of [a, b, decoy]) mkdirSync(join(dir, ".git"), { recursive: true });

    await seedProject("a", a);
    await seedProject("b", b);
    const decoyId = await seedProject("decoy", decoy);
    await h.db!.insert(schema.preferences).values({ key: "projects_base_path", value: oldRoot });

    const batch = await relocateProjectsUnderPrefix(oldRoot, newRoot, { moveFiles: true });

    expect(batch.results.map((r) => r.projectName).sort()).toEqual(["a", "b"]);
    expect(batch.results.every((r) => r.applied)).toBe(true);
    expect(existsSync(join(newRoot, "a", ".git"))).toBe(true);

    const [decoyRow] = await h.db!.select().from(schema.projects).where(eq(schema.projects.id, decoyId));
    expect(decoyRow!.repoPath).toBe(decoy);

    const [pref] = await h.db!
      .select()
      .from(schema.preferences)
      .where(eq(schema.preferences.key, "projects_base_path"));
    expect(pref!.value).toBe(newRoot);
    expect(batch.basePathChange).toMatchObject({ from: oldRoot, to: newRoot });
  });

  it("reports the projects_base_path rewrite on a dry run without performing it", async () => {
    const oldRoot = tempDir("oldroot");
    const newRoot = join(sandbox, "newroot");
    mkdirSync(join(oldRoot, "a", ".git"), { recursive: true });
    await seedProject("a", join(oldRoot, "a"));
    await h.db!.insert(schema.preferences).values({ key: "projects_base_path", value: oldRoot });

    const batch = await relocateProjectsUnderPrefix(oldRoot, newRoot, { moveFiles: true, dryRun: true });

    expect(batch.basePathChange).toMatchObject({ from: oldRoot, to: newRoot });
    const [pref] = await h.db!
      .select()
      .from(schema.preferences)
      .where(eq(schema.preferences.key, "projects_base_path"));
    expect(pref!.value).toBe(oldRoot);
  });
});
