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
type SessionActivity = {
  writtenAbs: Set<string>;
  writtenRel: Set<string>;
  agentCalls: number;
  subagentTranscripts: number;
  subagentAuthorshipUnknown: boolean;
} | null;
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
    // NB: the backslashes must be ESCAPED here. Written raw, the string was
    // `C:projectsandrenaagentic-kanban\\packages\\...` and matched only because attribution used a
    // loose suffix match — the very thing #720 tightened. See the cross-repo test below.
    const winPath = "C:\\projects\\andrena\\agentic-kanban\\" + MINE.replace(/\//g, "\\");
    const activity = readSessionActivity(await transcript([edit(winPath)]));
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

/**
 * #720 — the three ways #709's attribution filter was WRONG, all in the silent direction.
 *
 * #709 made the hook attribute the dirty set to the stopping session's own transcript and then
 * `process.exit(0)` when nothing was attributed. A false negative there is therefore SILENT, which
 * is the dangerous direction: real stranded work goes unreported. The ticket's own observation, run
 * against the real exported functions, was:
 *
 *     transcript: Agent(prompt names .../foo.ts)
 *                 Bash("cd packages/server && sed -i 's/a/b/' src/services/bar.ts")
 *                 Bash("cat .../readonly.ts")
 *     attributed: [ readonly.ts ]     // the one file it did NOT write
 *
 * Each `it` below pins one of the three defects plus the cross-repo suffix match.
 */
describe("check-uncommitted hook — attribution defects (#720)", () => {
  const REPO = "C:/projects/andrena/agentic-kanban";
  const OTHER_REPO = "C:/projects/andrena/other-board";
  const FOO = "packages/server/src/services/foo.ts";
  const BAR = "packages/server/src/services/bar.ts";
  const RO = "packages/server/src/services/readonly.ts";
  const ALL = [FOO, BAR, RO];

  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ak-hook-720-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const edit = (filePath: string) => ({ type: "tool_use", name: "Edit", input: { file_path: filePath } });
  const bash = (command: string) => ({ type: "tool_use", name: "Bash", input: { command } });
  const agent = (prompt: string) => ({ type: "tool_use", name: "Agent", input: { prompt } });

  /** A transcript whose entries carry a real `cwd`, which is what resolves relative shell paths. */
  async function transcriptAt(name: string, entries: unknown[], cwd = REPO): Promise<string> {
    const p = join(dir, name);
    await writeFile(p, entries.map((e) => JSON.stringify({ cwd, message: { content: [e] } })).join("\n") + "\n");
    return p;
  }

  /**
   * A parent transcript that spawned one subagent, laid out the way Claude Code does it:
   * `<dir>/<id>.jsonl` beside `<dir>/<id>/subagents/agent-<agentId>.jsonl`, with the parent's
   * tool RESULT carrying the `agentId`. `withSubTranscript: false` omits the child's file, which is
   * the case the hook cannot narrow.
   */
  async function parentWithSubagent(agentId: string, childBlocks: unknown[], withSubTranscript: boolean) {
    const p = join(dir, "parent.jsonl");
    await writeFile(
      p,
      [
        JSON.stringify({ cwd: REPO, message: { content: [agent("do the work")] } }),
        JSON.stringify({ cwd: REPO, toolUseResult: { agentId, status: "completed" } }),
      ].join("\n") + "\n",
    );
    if (withSubTranscript) {
      const subDir = join(dir, "parent", "subagents");
      await mkdir(subDir, { recursive: true });
      await writeFile(
        join(subDir, `agent-${agentId}.jsonl`),
        childBlocks.map((b) => JSON.stringify({ cwd: REPO, agentId, message: { content: [b] } })).join("\n") + "\n",
      );
    }
    return p;
  }

  it("defect 1: a SUBAGENT's writes are attributed from its own transcript", async () => {
    // Agent/Task was in neither WRITE_TOOLS nor SHELL_TOOLS, and the subagent's tool calls live in
    // a different file — so a session whose only main-checkout edits came from a subagent exited 0
    // with no warning at all. That is the modal case in a repo that fans work out constantly.
    const p = await parentWithSubagent("abc123def", [edit(`${REPO}/${FOO}`)], true);
    const activity = readSessionActivity(p);
    expect(activity?.subagentTranscripts).toBe(1);
    expect(activity?.subagentAuthorshipUnknown).toBe(false);
    expect(attributeToSession(ALL, activity, REPO)).toEqual([FOO]);
  });

  it("defect 1: a subagent whose transcript is MISSING reports EVERYTHING, never nothing", async () => {
    // Silence is the one outcome worse than noise: we know a subagent ran, so we cannot claim the
    // session wrote nothing. Fall back to the pre-#709 behaviour rather than exiting 0.
    const p = await parentWithSubagent("abc123def", [edit(`${REPO}/${FOO}`)], false);
    const activity = readSessionActivity(p);
    expect(activity?.agentCalls).toBe(1);
    expect(activity?.subagentAuthorshipUnknown).toBe(true);
    expect(attributeToSession(ALL, activity, REPO)).toEqual(ALL);
  });

  it("defect 2: `sed -i` after a `cd` is attributed (resolved against the effective cwd)", async () => {
    // The old code substring-matched the repo-RELATIVE porcelain path against the raw command text,
    // so `cd packages/server && sed -i ... src/services/bar.ts` never matched — and this repo's own
    // instructions tell agents to edit with sed.
    const activity = readSessionActivity(
      await transcriptAt("sed.jsonl", [bash("cd packages/server && sed -i 's/a/b/' src/services/bar.ts")]),
    );
    expect(attributeToSession(ALL, activity, REPO)).toEqual([BAR]);
  });

  it("defect 2: a `cd` into an absolute path elsewhere does NOT attribute this repo's files", async () => {
    const activity = readSessionActivity(
      await transcriptAt("cd-away.jsonl", [bash(`cd ${OTHER_REPO} && sed -i 's/a/b/' ${BAR}`)]),
    );
    expect(attributeToSession(ALL, activity, REPO)).toEqual([]);
  });

  it("defect 3: READING a file never makes the session its author", async () => {
    // `cat`/`grep`/`head` of a path used to attribute it. Under this repo's own instruction to read
    // with cat/head and search with grep, the filter degenerated to no filter.
    const activity = readSessionActivity(
      await transcriptAt("reads.jsonl", [
        bash(`cat ${RO}`),
        bash(`grep -n "export" ${FOO}`),
        bash(`head -40 ${BAR}`),
        bash(`sed -n '1,20p' ${BAR}`),
        bash(`git diff -- ${FOO}`),
        bash(`wc -l ${RO} | sort`),
      ]),
    );
    expect(attributeToSession(ALL, activity, REPO)).toEqual([]);
  });

  it("defect 3: a redirect into a file still attributes it, even from a read verb", async () => {
    // `cat > file <<EOF` is how an agent writes without an Edit call — the write half of the shell
    // scan must survive the read/write split.
    const activity = readSessionActivity(
      await transcriptAt("redirect.jsonl", [bash(`cat ${RO} > ${BAR}`)]),
    );
    expect(attributeToSession(ALL, activity, REPO)).toEqual([BAR]);
  });

  it("does not cross-attribute a same-relative-path file in a DIFFERENT repo", async () => {
    // The old `w.endsWith("/" + p)` matched any repo sharing the layout — so a session editing a
    // sibling board's packages/server/src/services/foo.ts was told to commit ours.
    const activity = readSessionActivity(await transcriptAt("cross.jsonl", [edit(`${OTHER_REPO}/${FOO}`)]));
    expect(attributeToSession(ALL, activity, REPO)).toEqual([]);
  });

  it("reproduces the ticket's exact observation, and now gets it right", async () => {
    // Before: attributed [readonly.ts] — the only file the session did NOT write.
    // After: the subagent is visible (and here unresolvable, so everything is reported rather than
    // the one wrong file), and `bar.ts` is attributed on its own merits.
    const withoutAgent = readSessionActivity(
      await transcriptAt("observed.jsonl", [
        bash("cd packages/server && sed -i 's/a/b/' src/services/bar.ts"),
        bash(`cat ${RO}`),
      ]),
    );
    expect(attributeToSession(ALL, withoutAgent, REPO)).toEqual([BAR]);

    const p = join(dir, "observed-agent.jsonl");
    await writeFile(
      p,
      [
        JSON.stringify({ cwd: REPO, message: { content: [agent(`edit ${REPO}/${FOO}`)] } }),
        JSON.stringify({
          cwd: REPO,
          message: { content: [bash("cd packages/server && sed -i 's/a/b/' src/services/bar.ts")] },
        }),
        JSON.stringify({ cwd: REPO, message: { content: [bash(`cat ${RO}`)] } }),
      ].join("\n") + "\n",
    );
    const withAgent = readSessionActivity(p);
    expect(withAgent?.subagentAuthorshipUnknown).toBe(true);
    expect(attributeToSession(ALL, withAgent, REPO)).toEqual(ALL);
  });

  it("still attributes plain write tools and plain shell writes with no subagent involved", async () => {
    // #709's actual win must survive: an uninvolved session is still handed nothing.
    const mineOnly = readSessionActivity(
      await transcriptAt("mine.jsonl", [edit(`${REPO}/${FOO}`), bash(`tee ${BAR} < /dev/null`)]),
    );
    expect(attributeToSession(ALL, mineOnly, REPO)).toEqual([FOO, BAR]);

    const elsewhere = readSessionActivity(
      await transcriptAt("elsewhere.jsonl", [edit(`${OTHER_REPO}/src/a.ts`), bash(`cat ${FOO}`)]),
    );
    expect(attributeToSession(ALL, elsewhere, REPO)).toEqual([]);
  });
});
