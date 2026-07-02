import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoRenumberMigrations } from "../src/lib/git-service.js";

const DRIZZLE_DIR = "packages/shared/drizzle";
const JOURNAL_PATH = `${DRIZZLE_DIR}/meta/_journal.json`;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout.toString());
    });
  });
}

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

function journal(tags: string[]): string {
  const entries: JournalEntry[] = tags.map((tag, i) => ({
    idx: i,
    version: "7",
    when: 1000 + i,
    tag,
    breakpoints: true,
  }));
  return JSON.stringify({ version: "7", dialect: "sqlite", entries }, null, 2) + "\n";
}

async function writeRepoFile(repo: string, relativePath: string, content: string): Promise<void> {
  const filePath = join(repo, ...relativePath.split("/"));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

describe("autoRenumberMigrations conflict-marker guard (#971)", () => {
  let root: string;
  let repo: string; // main checkout, on main
  let wt: string; // worktree, on feature branch

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ak-mig-renumber-"));
    repo = join(root, "repo");
    wt = join(root, "wt");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.email", "test@example.local"]);
    await git(repo, ["config", "user.name", "Migration Renumber Test"]);

    // Seed main: one existing migration + journal.
    await writeRepoFile(repo, `${DRIZZLE_DIR}/0001_init.sql`, "CREATE TABLE a (id integer);\n");
    await writeRepoFile(repo, JOURNAL_PATH, journal(["0001_init"]));
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "initial migrations"]);

    // Feature branch in a worktree.
    await git(repo, ["worktree", "add", wt, "-b", "feature/mig", "main"]);
    await git(wt, ["config", "user.email", "test@example.local"]);
    await git(wt, ["config", "user.name", "Migration Renumber Test"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  /** Advance main with an edit to 0001 (optional) plus a colliding 0002 migration. */
  async function advanceBase(editExisting: boolean): Promise<void> {
    if (editExisting) {
      await writeRepoFile(repo, `${DRIZZLE_DIR}/0001_init.sql`, "CREATE TABLE a (id integer, base_col text);\n");
    }
    await writeRepoFile(repo, `${DRIZZLE_DIR}/0002_base.sql`, "CREATE TABLE base_thing (id integer);\n");
    await writeRepoFile(repo, JOURNAL_PATH, journal(["0001_init", "0002_base"]));
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "base adds 0002_base"]);
  }

  it("aborts and does NOT commit when a migration .sql merges with conflict markers", async () => {
    // Feature edits the SAME existing migration (divergently from base) and adds a
    // colliding 0002 — the renumber merge then conflicts inside a .sql file.
    await writeRepoFile(wt, `${DRIZZLE_DIR}/0001_init.sql`, "CREATE TABLE a (id integer, feat_col text);\n");
    await writeRepoFile(wt, `${DRIZZLE_DIR}/0002_feat.sql`, "CREATE TABLE feat_thing (id integer);\n");
    await writeRepoFile(wt, JOURNAL_PATH, journal(["0001_init", "0002_feat"]));
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "-m", "feature edits 0001 and adds 0002_feat"]);

    await advanceBase(true);

    const err = await autoRenumberMigrations(wt, repo, "main").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/conflict markers/i);
    expect(err!.message).toContain("0001_init.sql");

    // The merge was aborted: no in-progress merge state, and NO committed file on the
    // feature branch carries conflict markers.
    expect(existsSync(join(repo, ".git", "worktrees"))).toBe(true);
    const mergeHead = await git(wt, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]).catch(() => "");
    expect(mergeHead.trim()).toBe("");

    const committedSql = await git(wt, ["show", `HEAD:${DRIZZLE_DIR}/0001_init.sql`]);
    expect(committedSql).not.toContain("<<<<<<<");
    const headSubject = await git(wt, ["log", "-1", "--format=%s"]);
    expect(headSubject).not.toContain("Merge");
  });

  it("still completes the renumber when only the journal conflicts (no .sql markers)", async () => {
    // Feature only ADDS a colliding migration — the merge conflicts on the journal
    // (re-asserted by the function), never inside a .sql file.
    await writeRepoFile(wt, `${DRIZZLE_DIR}/0002_feat.sql`, "CREATE TABLE feat_thing (id integer);\n");
    await writeRepoFile(wt, JOURNAL_PATH, journal(["0001_init", "0002_feat"]));
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "-m", "feature adds 0002_feat"]);

    await advanceBase(false);

    const result = await autoRenumberMigrations(wt, repo, "main");
    expect(result.renumbered).toBe(true);
    expect(result.renames).toEqual([{ from: "0002_feat.sql", to: "0003_feat.sql" }]);

    // Both migrations exist on the merged feature branch; journal is clean JSON.
    const tree = await git(wt, ["ls-tree", "--name-only", `HEAD:${DRIZZLE_DIR}`]);
    expect(tree).toContain("0002_base.sql");
    expect(tree).toContain("0003_feat.sql");
    const journalRaw = await git(wt, ["show", `HEAD:${JOURNAL_PATH}`]);
    expect(journalRaw).not.toContain("<<<<<<<");
    const parsed = JSON.parse(journalRaw.trim()) as { entries: JournalEntry[] };
    expect(parsed.entries.map((e) => e.tag)).toEqual(["0001_init", "0002_base", "0003_feat"]);
  });
});
