/**
 * Regression tests for the check-uncommitted Stop hook deletion-vs-edit
 * classification (ticket #771, bug 2).
 *
 * A working tree dominated by DELETED tracked source files (`D` in porcelain) is a
 * merge working-tree desync to RESTORE — never a set of changes to COMMIT. The hook
 * must never tell the agent to "commit them before stopping" when the tree is full of
 * deletions; following that would delete packages/shared from the branch. These tests
 * exercise the pure classifier plus the porcelain parser against a real temp git repo.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const requireCjs = createRequire(import.meta.url);
// Hook lives at repo-root/.claude/hooks/check-uncommitted.js. From
// packages/server/src/__tests__ that's five levels up.
const hookPath = resolve(import.meta.dirname, "..", "..", "..", "..", ".claude", "hooks", "check-uncommitted.js");
type SessionActivity = { written: Set<string>; commandText: string } | null;
const { classifyStranded, trackedSourceChanges, readSessionActivity, attributeToSession } = requireCjs(hookPath) as {
  classifyStranded: (c: { edited: string[]; deleted: string[]; all: string[] }) => { action: string; files?: string[]; deleted?: string[]; edited?: string[] };
  trackedSourceChanges: (cwd: string) => { edited: string[]; deleted: string[]; all: string[] };
  readSessionActivity: (transcriptPath: string | undefined) => SessionActivity;
  attributeToSession: (paths: string[], activity: SessionActivity, repoRoot: string) => string[];
};

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((res, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else res(stdout.toString());
    });
  });
}

async function writeFileIn(repo: string, rel: string, content: string): Promise<void> {
  const p = join(repo, ...rel.split("/"));
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content);
}

describe("check-uncommitted hook — classifyStranded (deletion vs edit)", () => {
  it("returns ok when nothing is stranded", () => {
    expect(classifyStranded({ edited: [], deleted: [], all: [] })).toEqual({ action: "ok" });
  });

  it("returns commit for a genuine stranded edit", () => {
    const c = { edited: ["packages/server/src/x.ts"], deleted: [], all: ["packages/server/src/x.ts"] };
    expect(classifyStranded(c)).toEqual({ action: "commit", files: c.all });
  });

  it("returns restore for a deletion-dominant working tree (mass-deletion desync)", () => {
    const deleted = Array.from({ length: 120 }, (_, i) => `packages/shared/src/f${i}.ts`);
    const v = classifyStranded({ edited: [], deleted, all: deleted });
    expect(v.action).toBe("restore");
    expect(v.deleted).toHaveLength(120);
  });

  it("returns restore when deletions tie or outnumber edits", () => {
    // 2 deletions vs 1 edit → desync wins (deletions are the dangerous signal).
    const v = classifyStranded({
      edited: ["packages/server/src/a.ts"],
      deleted: ["packages/shared/src/b.ts", "packages/shared/src/c.ts"],
      all: ["packages/server/src/a.ts", "packages/shared/src/b.ts", "packages/shared/src/c.ts"],
    });
    expect(v.action).toBe("restore");
  });

  it("returns commit when edits dominate over a stray deletion", () => {
    const v = classifyStranded({
      edited: ["packages/server/src/a.ts", "packages/server/src/b.ts", "packages/server/src/c.ts"],
      deleted: ["packages/server/src/old.ts"],
      all: ["packages/server/src/a.ts", "packages/server/src/b.ts", "packages/server/src/c.ts", "packages/server/src/old.ts"],
    });
    expect(v.action).toBe("commit");
  });
});

describe("check-uncommitted hook — trackedSourceChanges porcelain parsing", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ak-uncommitted-hook-"));
    await git(repo, ["init", "-q", "-b", "main"]);
    for (let i = 0; i < 5; i++) {
      await writeFileIn(repo, `packages/shared/src/f${i}.ts`, `export const f${i} = ${i};\n`);
    }
    await writeFileIn(repo, "packages/server/src/keep.ts", "export const keep = 1;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "seed"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("classifies removed-from-disk tracked source files as deletions, driving a restore verdict", async () => {
    // Simulate the desync: the shared source tree removed from disk, HEAD still has it.
    for (let i = 0; i < 5; i++) {
      await rm(join(repo, "packages", "shared", "src", `f${i}.ts`), { force: true });
    }
    const changes = trackedSourceChanges(repo);
    expect(changes.deleted).toHaveLength(5);
    expect(changes.edited).toHaveLength(0);
    expect(classifyStranded(changes).action).toBe("restore");
  });

  it("classifies an edited tracked source file as an edit, driving a commit verdict", async () => {
    await writeFileIn(repo, "packages/server/src/keep.ts", "export const keep = 2; // edited\n");
    const changes = trackedSourceChanges(repo);
    expect(changes.edited).toEqual(["packages/server/src/keep.ts"]);
    expect(changes.deleted).toHaveLength(0);
    expect(classifyStranded(changes).action).toBe("commit");
  });

  it("ignores untracked files and non-source paths", async () => {
    await writeFileIn(repo, "packages/server/notes.md", "scratch\n");
    await writeFileIn(repo, "screenshot.png", "binary\n");
    const changes = trackedSourceChanges(repo);
    expect(changes.all).toHaveLength(0);
    expect(classifyStranded(changes)).toEqual({ action: "ok" });
  });
});

/**
 * #709 — the Stop hook told UNINVOLVED sessions to commit other agents' in-flight work.
 *
 * Observed three times in one session: a session whose every edit was in a different repo
 * was blocked on Stop and handed 14 files from another agent's sweep, one of which was a new
 * file the others referenced — committing that snapshot would have landed a non-compiling
 * tree under the wrong author. These tests are the ticket's own verify recipe, expressed
 * against the pure attribution pair rather than two live sessions.
 */
describe("check-uncommitted hook — authorship attribution (#709)", () => {
  const REPO = "C:/projects/andrena/agentic-kanban";
  const MINE = "packages/server/src/services/mine.ts";
  const THEIRS = "packages/server/src/services/theirs.ts";

  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ak-hook-709-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function transcript(blocks: unknown[]): Promise<string> {
    const p = join(dir, "transcript.jsonl");
    await writeFile(p, blocks.map((b) => JSON.stringify({ message: { content: [b] } })).join("\n") + "\n");
    return p;
  }

  const edit = (filePath: string) => ({ type: "tool_use", name: "Edit", input: { file_path: filePath } });
  const bash = (command: string) => ({ type: "tool_use", name: "Bash", input: { command } });

  it("a session that wrote nothing in this repo is told nothing — the whole point", async () => {
    // Ticket's recipe, session B: it worked entirely in another repo. Its Stop must pass clean
    // even though the checkout is dirty with someone else's live work.
    const activity = readSessionActivity(await transcript([edit("C:/projects/andrena/code-metrics-skill/src/a.ts")]));
    expect(attributeToSession([MINE, THEIRS], activity, REPO)).toEqual([]);
  });

  it("a session IS still told about its own files", async () => {
    // Recipe, session A: the warning must survive for the author. A hook that goes quiet for
    // everyone would trade one failure mode for a worse one.
    const activity = readSessionActivity(await transcript([edit(`${REPO}/${MINE}`)]));
    expect(attributeToSession([MINE, THEIRS], activity, REPO)).toEqual([MINE]);
  });

  it("attributes a file the session wrote through a SHELL command", async () => {
    // A session editing with `sed -i` or a heredoc makes no Edit call at all. Scanning only
    // write-tool targets would silently stop warning it about its OWN stranded work.
    const activity = readSessionActivity(await transcript([bash(`sed -i s/a/b/ ${MINE}`)]));
    expect(attributeToSession([MINE, THEIRS], activity, REPO)).toEqual([MINE]);
  });

  it("matches a write-tool path recorded with Windows separators", async () => {
    const activity = readSessionActivity(await transcript([edit("C:\projects\andrena\agentic-kanban\\" + MINE.replace(/\//g, "\\"))]));
    expect(attributeToSession([MINE, THEIRS], activity, REPO)).toEqual([MINE]);
  });

  it("falls back to warning about EVERYTHING when the transcript cannot be read", () => {
    // Load-bearing: unknown authorship must degrade to the OLD behaviour, never to silence.
    // A hook that goes quiet when it cannot tell is worse than one that over-reports.
    expect(readSessionActivity(join(dir, "does-not-exist.jsonl"))).toBeNull();
    expect(readSessionActivity(undefined)).toBeNull();
    expect(attributeToSession([MINE, THEIRS], null, REPO)).toEqual([MINE, THEIRS]);
  });

  it("survives a partially-flushed final line, which a LIVE transcript always has", async () => {
    const p = join(dir, "partial.jsonl");
    await writeFile(p, JSON.stringify({ message: { content: [edit(`${REPO}/${MINE}`)] } }) + "\n" + '{"message": {"cont');
    const activity = readSessionActivity(p);
    expect(activity).not.toBeNull();
    expect(attributeToSession([MINE, THEIRS], activity, REPO)).toEqual([MINE]);
  });

  it("ignores non-write tool calls", async () => {
    const activity = readSessionActivity(
      await transcript([{ type: "tool_use", name: "Read", input: { file_path: `${REPO}/${THEIRS}` } }]),
    );
    expect(attributeToSession([MINE, THEIRS], activity, REPO)).toEqual([]);
  });
});
