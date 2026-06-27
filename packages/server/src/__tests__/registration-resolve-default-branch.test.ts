// @covers project-registration.resolve.defaultBranch [regression,error-handling,boundary]
//
// #772 never-null-defaultBranch guarantee.
//
// detectRepoInfo() only recognises a local `main`/`master`; a repo whose checked-out
// branch is named anything else returns defaultBranch=null. If registerProject() stored
// that null, the project would be SILENTLY UNDRIVEABLE: POST /api/workspaces later 400s
// "No default branch configured" and the monitor's auto-start swallows it. registerProject
// must fall back to the repo's actually checked-out branch (resolveDefaultBranch,
// project-registration.ts:39 / :168) so defaultBranch is never null when a branch exists.
//
// This drives the REAL registerProject() against REAL temp git repos, with the global db
// swapped for an in-memory test db, and asserts the persisted project's defaultBranch.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Swap the global db for a fresh in-memory libsql db so registerProject() (which writes
// through the default-arg `db` of its repository functions) hits a throwaway database.
// withTransaction/writeDb are provided for transitive importers of ../db/index.js.
vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const schemaMod = await import("@agentic-kanban/shared/schema");
  const { db } = createTestDb();
  return {
    db,
    writeDb: db,
    rawClient: undefined,
    rawWriteClient: undefined,
    schema: schemaMod,
    withDbRetry: <T>(fn: () => Promise<T>) => fn(),
    withTransaction: <T>(database: { transaction: (fn: unknown) => Promise<T> }, fn: unknown) =>
      database.transaction(fn),
  };
});

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { projects } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import { registerProject } from "../services/project-registration.js";

/** Create a real git repo on `initialBranch` with one commit, return its path. */
function makeGitRepo(initialBranch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kanban-defbranch-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  // -b sets the initial branch name without relying on global init.defaultBranch.
  git("init", "-b", initialBranch);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Registration Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git("add", "README.md");
  git("commit", "-m", "initial");
  return dir;
}

describe("registerProject — never-null defaultBranch (#772)", () => {
  const dirs: string[] = [];

  beforeAll(() => {
    // Each case gets its own repo so they register as distinct projects (the same
    // git root would be deduped into one via idempotent registration).
  });

  afterAll(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  });

  it("uses the detected branch when the repo is on a standard `main`", async () => {
    const repo = makeGitRepo("main");
    dirs.push(repo);

    const { project, created } = await registerProject(repo);

    expect(created).toBe(true);
    expect(project.defaultBranch).toBe("main");

    // Persisted (not just returned): the DB row also carries the non-null branch.
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row.defaultBranch).toBe("main");
  });

  it("falls back to the checked-out branch when it is NOT main/master (the #772 path)", async () => {
    // detectRepoInfo() returns defaultBranch=null for a `trunk`-only repo; resolveDefaultBranch
    // must recover by reading the actually checked-out branch.
    const repo = makeGitRepo("trunk");
    dirs.push(repo);

    const { project } = await registerProject(repo);

    // The guarantee: never null, and specifically the real checked-out branch.
    expect(project.defaultBranch).not.toBeNull();
    expect(project.defaultBranch).toBe("trunk");

    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    // A regression that stored the raw `detected` (null) here would re-create the
    // silently-undriveable project this test guards against.
    expect(row.defaultBranch).not.toBeNull();
    expect(row.defaultBranch).toBe("trunk");
  });

  it("resolves a usable, non-HEAD branch name for any non-standard branch (regression)", async () => {
    const repo = makeGitRepo("release-2026");
    dirs.push(repo);

    const { project } = await registerProject(repo);

    // A usable branch name — non-null, non-empty, and never the detached sentinel "HEAD".
    expect(project.defaultBranch).toBeTruthy();
    expect(typeof project.defaultBranch).toBe("string");
    expect(project.defaultBranch).not.toBe("HEAD");
    expect((project.defaultBranch ?? "").length).toBeGreaterThan(0);
    expect(project.defaultBranch).toBe("release-2026");
  });

  it("persists defaultBranch=null on a DETACHED HEAD — no usable branch exists (boundary/error-handling)", async () => {
    // The honest edge of the contract ("never null WHEN a branch exists"): with a detached
    // HEAD there is NO checked-out branch. detectRepoInfo() returns null (branch is `trunk`,
    // not main/master) AND getCurrentBranch() returns the sentinel "HEAD", which the :47 guard
    // rejects — so resolveDefaultBranch returns null and registerProject persists null.
    // This LOCKS the `&& current !== "HEAD"` guard: deleting it would store "HEAD" here (red).
    const repo = makeGitRepo("trunk");
    dirs.push(repo);
    // Detach onto the commit so `git rev-parse --abbrev-ref HEAD` yields "HEAD".
    execFileSync("git", ["checkout", "--detach", "HEAD"], { cwd: repo, stdio: "pipe" });

    const { project, created } = await registerProject(repo);

    expect(created).toBe(true);
    // No usable branch → honestly null (the project is flagged undriveable rather than
    // silently storing a bogus "HEAD" ref that later git ops would choke on).
    expect(project.defaultBranch).toBeNull();

    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row.defaultBranch).toBeNull();
  });
});
