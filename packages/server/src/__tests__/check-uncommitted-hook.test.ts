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
import { execFile, spawn } from "node:child_process";
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
  inFlightAbs: Set<string>;
  inFlightRel: Set<string>;
  liveSubagents: number;
  agentCalls: number;
  subagentTranscripts: number;
  subagentAuthorshipUnknown: boolean;
} | null;
type StopReport = { exitCode: number; lines: string[] };
const {
  classifyStranded,
  trackedSourceChanges,
  readSessionActivity,
  attributeToSession,
  partitionAuthored,
  buildStopReport,
  SUBAGENT_STALE_MS,
  isValidPathToken,
  harvestPathLiterals,
  heredocStrongWriteTargets,
  disqualifyFreshForeign,
  FRESH_FOREIGN_MS,
} = requireCjs(hookPath) as {
  classifyStranded: (c: { edited: string[]; deleted: string[]; all: string[] }) => { action: string; files?: string[]; deleted?: string[]; edited?: string[] };
  trackedSourceChanges: (cwd: string) => { edited: string[]; deleted: string[]; all: string[] };
  readSessionActivity: (transcriptPath: string | undefined, nowMs?: number) => SessionActivity;
  attributeToSession: (paths: string[], activity: SessionActivity, repoRoot: string) => string[];
  partitionAuthored: (paths: string[], activity: SessionActivity, repoRoot: string) => { stranded: string[]; inFlight: string[]; unknown?: string[]; weak?: string[] };
  buildStopReport: (arg: { stranded: string[]; inFlight: string[]; unknown?: string[]; weak?: string[]; freshForeign?: string[]; activity: SessionActivity; totalDirty?: number }) => StopReport;
  SUBAGENT_STALE_MS: number;
  isValidPathToken: (raw: string) => boolean;
  harvestPathLiterals: (command: string) => string[];
  heredocStrongWriteTargets: (command: string) => string[];
  disqualifyFreshForeign: (
    stranded: string[],
    strongSet: Set<string>,
    repoRoot: string,
    opts?: { statFn?: (p: string) => { mtimeMs: number }; nowMs?: number },
  ) => { stranded: string[]; freshForeign: string[] };
  FRESH_FOREIGN_MS: number;
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
/**
 * #724 — IN FLIGHT vs STRANDED.
 *
 * #720 made a parent see its subagents' writes. The consequence, hit repeatedly in one
 * orchestrator session that ran up to 9 implementation subagents against the shared main
 * checkout: every turn end listed those live agents' half-finished files as "written by THIS
 * session — commit them before stopping". One was mid-refactor with a syntax error. Committing on
 * that advice is the cross-author, broken-intermediate commit the root CLAUDE.md names by hash.
 *
 * The distinguishing signal comes from the subagent's own transcript, and the fixtures below
 * mirror what real ones look like (checked against 26 transcripts of the session that filed this
 * ticket): a FINISHED subagent's last assistant entry carries `stop_reason: "end_turn"`; a LIVE
 * one ends on a `tool_use` whose result never arrived. The parent's tool result cannot tell you —
 * subagents launch async, so it reads `status: "async_launched"` from the moment they start.
 */
describe("check-uncommitted hook — in-flight vs stranded (#724)", () => {
  const REPO = "C:/projects/andrena/agentic-kanban";
  const FOO = "packages/server/src/services/foo.ts";
  const BAR = "packages/server/src/services/bar.ts";
  const ALL = [FOO, BAR];

  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ak-hook-724-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const edit = (filePath: string) => ({ type: "tool_use", name: "Edit", input: { file_path: filePath } });
  const agent = (prompt: string) => ({ type: "tool_use", name: "Agent", input: { prompt } });

  /**
   * A parent transcript plus one subagent transcript, in Claude Code's real on-disk layout.
   * `closed: true` appends the terminal `end_turn` assistant entry a finished subagent writes;
   * `closed: false` leaves the transcript ending on an unanswered tool_use, i.e. still running.
   * `parentBlocks` are the parent's OWN write tool calls, which are never in flight.
   */
  async function session(opts: {
    agentId: string;
    childBlocks: unknown[];
    closed: boolean;
    parentBlocks?: unknown[];
    withSubTranscript?: boolean;
  }): Promise<string> {
    const p = join(dir, "parent.jsonl");
    const parentLines = [
      JSON.stringify({ cwd: REPO, message: { content: [agent("do the work")] } }),
      // Real shape: the parent's result records the LAUNCH, not the outcome.
      JSON.stringify({ cwd: REPO, toolUseResult: { agentId: opts.agentId, status: "async_launched" } }),
      ...(opts.parentBlocks ?? []).map((b) => JSON.stringify({ cwd: REPO, type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [b] } })),
    ];
    await writeFile(p, parentLines.join("\n") + "\n");
    if (opts.withSubTranscript !== false) {
      const subDir = join(dir, "parent", "subagents");
      await mkdir(subDir, { recursive: true });
      const lines = opts.childBlocks.map((b) =>
        JSON.stringify({ cwd: REPO, agentId: opts.agentId, type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [b] } }),
      );
      if (opts.closed) {
        lines.push(
          JSON.stringify({ cwd: REPO, agentId: opts.agentId, type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } }),
        );
      }
      await writeFile(join(subDir, `agent-${opts.agentId}.jsonl`), lines.join("\n") + "\n");
    }
    return p;
  }

  it("a file written by a STILL-RUNNING subagent is IN FLIGHT, never demanded", async () => {
    const p = await session({ agentId: "aliveaaa1", childBlocks: [edit(`${REPO}/${FOO}`)], closed: false });
    const activity = readSessionActivity(p);
    expect(activity?.subagentAuthorshipUnknown).toBe(false);
    expect(activity?.liveSubagents).toBe(1);
    // Still ATTRIBUTED to this session (#720 stays true) — but not stranded.
    expect(attributeToSession(ALL, activity, REPO)).toEqual([FOO]);
    expect(partitionAuthored(ALL, activity, REPO)).toEqual({ stranded: [], inFlight: [FOO] });
  });

  it("a file written by a FINISHED subagent IS demanded (stranded)", async () => {
    const p = await session({ agentId: "doneaaaa1", childBlocks: [edit(`${REPO}/${FOO}`)], closed: true });
    const activity = readSessionActivity(p);
    expect(activity?.liveSubagents).toBe(0);
    expect(partitionAuthored(ALL, activity, REPO)).toEqual({ stranded: [FOO], inFlight: [] });
    expect(buildStopReport({ stranded: [FOO], inFlight: [], activity }).exitCode).toBe(1);
  });

  it("when EVERY dirty file is in flight the hook exits 0 with an informational line", async () => {
    const p = await session({ agentId: "aliveaaa2", childBlocks: [edit(`${REPO}/${FOO}`), edit(`${REPO}/${BAR}`)], closed: false });
    const activity = readSessionActivity(p);
    const { stranded, inFlight } = partitionAuthored(ALL, activity, REPO);
    expect(stranded).toEqual([]);
    expect(inFlight).toEqual(ALL);
    const report = buildStopReport({ stranded, inFlight, activity, totalDirty: ALL.length });
    expect(report.exitCode).toBe(0);
    const text = report.lines.join("\n");
    expect(text).toContain("IN FLIGHT");
    expect(text).toContain("Nothing is STRANDED");
    // The dangerous sentence must be absent entirely, not merely softened.
    expect(text).not.toContain("Commit them before stopping");
  });

  it("names the two states DIFFERENTLY — the core of the ticket", async () => {
    const strandedOnly = buildStopReport({
      stranded: [FOO],
      inFlight: [],
      activity: { writtenAbs: new Set(), writtenRel: new Set(), inFlightAbs: new Set(), inFlightRel: new Set(), liveSubagents: 0, agentCalls: 0, subagentTranscripts: 0, subagentAuthorshipUnknown: false },
    });
    const inFlightOnly = buildStopReport({
      stranded: [],
      inFlight: [FOO],
      activity: { writtenAbs: new Set(), writtenRel: new Set(), inFlightAbs: new Set(), inFlightRel: new Set(), liveSubagents: 1, agentCalls: 1, subagentTranscripts: 1, subagentAuthorshipUnknown: false },
    });
    const strandedText = strandedOnly.lines.join("\n");
    const inFlightText = inFlightOnly.lines.join("\n");

    expect(strandedText).toContain("written by THIS session");
    expect(strandedText).toContain("Commit them before stopping");
    expect(strandedText).not.toContain("IN FLIGHT");

    expect(inFlightText).toContain("IN FLIGHT");
    expect(inFlightText).toContain("Do NOT commit");
    expect(inFlightText).not.toContain("written by THIS session");

    // Same file, opposite advice — so the wordings cannot be confused for one another.
    expect(strandedText).not.toEqual(inFlightText);
    expect(strandedOnly.exitCode).not.toBe(inFlightOnly.exitCode);
  });

  it("a MIXED tree lists both sets and scopes the commit demand to the stranded ones", async () => {
    const p = await session({
      agentId: "aliveaaa3",
      childBlocks: [edit(`${REPO}/${FOO}`)],
      closed: false,
      parentBlocks: [edit(`${REPO}/${BAR}`)],
    });
    const activity = readSessionActivity(p);
    const { stranded, inFlight } = partitionAuthored(ALL, activity, REPO);
    expect(stranded).toEqual([BAR]);
    expect(inFlight).toEqual([FOO]);
    const report = buildStopReport({ stranded, inFlight, activity, totalDirty: ALL.length });
    expect(report.exitCode).toBe(1);
    const text = report.lines.join("\n");
    expect(text).toContain(`  - ${BAR}`);
    expect(text).toContain(`  ~ ${FOO}`);
    expect(text).toContain("Commit the STRANDED files listed above");
    expect(text).not.toContain("Commit them before stopping");
  });

  it("a subagent whose transcript has gone STALE is treated as stranded, not live", async () => {
    // A subagent that died without ever closing its turn would otherwise look live forever —
    // silence, which is the one outcome worse than noise. Past the staleness window its files
    // are reported again.
    const p = await session({ agentId: "staleaaa1", childBlocks: [edit(`${REPO}/${FOO}`)], closed: false });
    const fresh = readSessionActivity(p);
    expect(fresh?.liveSubagents).toBe(1);
    const stale = readSessionActivity(p, Date.now() + 2 * SUBAGENT_STALE_MS);
    expect(stale?.liveSubagents).toBe(0);
    expect(partitionAuthored(ALL, stale, REPO)).toEqual({ stranded: [FOO], inFlight: [] });
  });

  it("keeps #720's safe direction: an unresolvable subagent still reports EVERYTHING as stranded", async () => {
    const p = await session({ agentId: "missingaa", childBlocks: [edit(`${REPO}/${FOO}`)], closed: false, withSubTranscript: false });
    const activity = readSessionActivity(p);
    expect(activity?.subagentAuthorshipUnknown).toBe(true);
    // Unknown authorship must NOT be laundered into "probably in flight, exit 0".
    expect(partitionAuthored(ALL, activity, REPO)).toEqual({ stranded: ALL, inFlight: [] });
    const report = buildStopReport({ stranded: ALL, inFlight: [], activity, totalDirty: ALL.length });
    expect(report.exitCode).toBe(1);
    expect(report.lines.join("\n")).toContain("authorship UNCERTAIN");
  });

  it("an unreadable transcript still reports everything (null activity)", () => {
    expect(partitionAuthored(ALL, null, REPO)).toEqual({ stranded: ALL, inFlight: [] });
    expect(buildStopReport({ stranded: ALL, inFlight: [], activity: null }).exitCode).toBe(1);
  });

  it("still runs as a live Stop hook script and exits 0 on re-entry", async () => {
    // This file IS the checkout's wired Stop hook, so the script path must keep working — a
    // regression here breaks every session's stop, not just this test.
    const code = await new Promise<number | null>((res, reject) => {
      const child = spawn(process.execPath, [hookPath], { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", reject);
      child.on("close", (c) => res(c));
      child.stdin!.end(JSON.stringify({ stop_hook_active: true }));
    });
    expect(code).toBe(0);
  });
});

/**
 * #884 — the Stop hook instructs only on STRONG evidence, and the harvester stops eating prose.
 *
 * Measured against the live weak set: 10,286 entries, 39% not paths — code fragments, markdown
 * fence fragments, and whole `git commit -F msg -- <pathspec list>` lines swallowed as ONE
 * pseudo-path. The hook's own comments said the weak tier "must never be the basis for telling a
 * session to commit", but with no live subagent the Stop report was not gated on the strong tier.
 * And the strong tier had false negatives: files written via `python - <<'PY'` / `node - <<'JS'`
 * heredocs were invisible to it. Each `describe` below pins one of the ticket's four points.
 */
describe("check-uncommitted hook — harvester validity filter and pathspec splitting (#884 p1)", () => {
  it("rejects tokens containing quotes, parens, `::`, embedded colons, and literal escapes", () => {
    expect(isValidPathToken("packages/server/src/x.ts")).toBe(true);
    expect(isValidPathToken("C:/projects/andrena/agentic-kanban/packages/server/src/x.ts")).toBe(true);
    expect(isValidPathToken("C:\\projects\\andrena\\x.ts")).toBe(true);
    expect(isValidPathToken("p.includes('session-lifecycle'))")).toBe(false);
    expect(isValidPathToken('say("hello/world.ts")')).toBe(false);
    expect(isValidPathToken("Foo::Bar/baz.ts")).toBe(false);
    expect(isValidPathToken("msg.txt -- packages/a.ts packages/b.ts")).toBe(false); // whitespace span
    expect(isValidPathToken("line1\\nline2/part.ts")).toBe(false); // literal \n escape
    expect(isValidPathToken("a|b/pipe.ts")).toBe(false);
    expect(isValidPathToken("")).toBe(false);
  });

  it("splits a ` -- `-separated pathspec list into member paths instead of one giant pseudo-path", () => {
    const harvested = harvestPathLiterals(
      "git commit -F msg.txt -- packages/server/src/a.ts packages/shared/src/b.ts",
    );
    expect(harvested).toContain("packages/server/src/a.ts");
    expect(harvested).toContain("packages/shared/src/b.ts");
    // The old harvester (spaces allowed inside a token) produced one span covering the whole list.
    for (const t of harvested) expect(t).not.toMatch(/\s/);
  });

  it("does not harvest prose or code fragments as paths", () => {
    const harvested = harvestPathLiterals(
      [
        "python - <<'PY'",
        "# see docs/notes and read the file, then s/a/b/ it",
        "print('markdown fence: ```ts packages/server')",
        "PY",
      ].join("\n"),
    );
    // Nothing above is a path literal ending in an extension without junk around it.
    expect(harvested).toEqual([]);
  });
});

describe("check-uncommitted hook — weak evidence reports, never instructs (#884 p2)", () => {
  const REPO = "C:/projects/andrena/agentic-kanban";
  const MINE = "packages/server/src/services/mine.ts";
  const THEIRS = "packages/server/src/services/theirs.ts";

  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ak-hook-884-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const bash = (command: string) => ({ type: "tool_use", name: "Bash", input: { command } });

  async function transcript(blocks: unknown[]): Promise<string> {
    const p = join(dir, "transcript.jsonl");
    await writeFile(p, blocks.map((b) => JSON.stringify({ cwd: REPO, message: { content: [b] } })).join("\n") + "\n");
    return p;
  }

  it("a weakly-attributed file (unclassified verb) gets a soft mention, not a commit instruction", async () => {
    // `mytool <path>` — the scanner cannot classify the verb, so the path is a GUESS. #884: a
    // guess may say "dirty, possibly yours"; it must never say "commit this before stopping".
    const activity = readSessionActivity(await transcript([bash(`mytool ${MINE}`)]));
    const part = partitionAuthored([MINE, THEIRS], activity, REPO);
    expect(part.stranded).toEqual([]);
    expect(part.weak).toEqual([MINE]);
    const report = buildStopReport({ ...part, activity, totalDirty: 2 });
    expect(report.exitCode).toBe(0);
    const text = report.lines.join("\n");
    expect(text).toContain("POSSIBLY YOURS");
    expect(text).toContain("Verify before committing");
    expect(text).toContain("may belong to another session");
    expect(text).toContain(`  * ${MINE}`);
    expect(text).not.toContain("Commit them before stopping");
    expect(text).not.toContain(`  - ${MINE}`);
  });

  it("a strongly-attributed file is still demanded — the warning must survive for the author", async () => {
    const activity = readSessionActivity(await transcript([bash(`sed -i 's/a/b/' ${MINE}`)]));
    const part = partitionAuthored([MINE, THEIRS], activity, REPO);
    expect(part.stranded).toEqual([MINE]);
    expect(part.weak ?? []).toEqual([]);
    expect(buildStopReport({ ...part, activity, totalDirty: 2 }).exitCode).toBe(1);
  });

  it("mixed strong + weak: only the strong file carries the demand, the weak one is soft-mentioned", async () => {
    const activity = readSessionActivity(
      await transcript([bash(`sed -i 's/a/b/' ${MINE}`), bash(`mytool ${THEIRS}`)]),
    );
    const part = partitionAuthored([MINE, THEIRS], activity, REPO);
    expect(part.stranded).toEqual([MINE]);
    expect(part.weak).toEqual([THEIRS]);
    const report = buildStopReport({ ...part, activity, totalDirty: 2 });
    expect(report.exitCode).toBe(1);
    const text = report.lines.join("\n");
    expect(text).toContain(`  - ${MINE}`);
    expect(text).toContain(`  * ${THEIRS}`);
  });
});

describe("check-uncommitted hook — heredoc writes are STRONG evidence (#884 p3)", () => {
  const REPO = "C:/projects/andrena/agentic-kanban";
  const MINE = "packages/server/src/services/mine.ts";
  const THEIRS = "packages/server/src/services/theirs.ts";

  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ak-hook-884h-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const bash = (command: string) => ({ type: "tool_use", name: "Bash", input: { command } });

  async function transcript(blocks: unknown[]): Promise<string> {
    const p = join(dir, "transcript.jsonl");
    await writeFile(p, blocks.map((b) => JSON.stringify({ cwd: REPO, message: { content: [b] } })).join("\n") + "\n");
    return p;
  }

  it("extracts literal open(...,'w') and writeFileSync targets from heredoc bodies", () => {
    expect(
      heredocStrongWriteTargets(
        ["python - <<'PY'", `open("${MINE}", "w").write("x")`, "PY"].join("\n"),
      ),
    ).toEqual([MINE]);
    expect(
      heredocStrongWriteTargets(
        ["node - <<'JS'", `require("fs").writeFileSync("${MINE}", s)`, "JS"].join("\n"),
      ),
    ).toEqual([MINE]);
    // A read (mode "r" / no mode) or a VARIABLE path is not strong evidence.
    expect(
      heredocStrongWriteTargets(["python - <<'PY'", `open("${MINE}").read()`, "PY"].join("\n")),
    ).toEqual([]);
    expect(
      heredocStrongWriteTargets(["python - <<'PY'", 'open(p, "w").write(s)', "PY"].join("\n")),
    ).toEqual([]);
  });

  it("a python-heredoc write with a literal path is STRANDED (demanded), not merely weak", async () => {
    const activity = readSessionActivity(
      await transcript([bash(["python - <<'PY'", `open("${MINE}", "w").write("x")`, "PY"].join("\n"))]),
    );
    const part = partitionAuthored([MINE, THEIRS], activity, REPO);
    expect(part.stranded).toEqual([MINE]);
    expect(buildStopReport({ ...part, activity, totalDirty: 2 }).exitCode).toBe(1);
  });

  it("`cat > X <<EOF` is strong via the intro line's redirect", async () => {
    const activity = readSessionActivity(
      await transcript([bash([`cat > ${REPO}/${MINE} <<'EOF'`, "content line", "EOF"].join("\n"))]),
    );
    const part = partitionAuthored([MINE, THEIRS], activity, REPO);
    expect(part.stranded).toEqual([MINE]);
  });

  it("heredoc BODY lines are not fed to the segment scanner (no false strong from a `>` in data)", async () => {
    // A body line containing `>` used to parse as a redirect and mint STRONG evidence out of data.
    const activity = readSessionActivity(
      await transcript([
        bash(["python - <<'PY'", `print("if x > 1: see ${THEIRS}")`, "PY"].join("\n")),
      ]),
    );
    const part = partitionAuthored([MINE, THEIRS], activity, REPO);
    expect(part.stranded).toEqual([]);
  });
});

describe("check-uncommitted hook — fresh-mtime foreign files are never demanded (#884 p4)", () => {
  const REPO = "C:/projects/andrena/agentic-kanban";
  const FRESH = "packages/server/src/services/fresh.ts";
  const OLD = "packages/server/src/services/old.ts";
  const STRONG = "packages/server/src/services/strong.ts";

  const statFor = (mtimes: Record<string, number>) => (p: string) => {
    const rel = p.replace(/\\/g, "/").replace(`${REPO}/`, "");
    if (!(rel in mtimes)) throw new Error("ENOENT");
    return { mtimeMs: mtimes[rel] };
  };

  it("a very recently modified file without strong attribution is disqualified", () => {
    const now = 10_000_000;
    const { stranded, freshForeign } = disqualifyFreshForeign(
      [FRESH, OLD],
      new Set(),
      REPO,
      { statFn: statFor({ [FRESH]: now - 30_000, [OLD]: now - 10 * FRESH_FOREIGN_MS }), nowMs: now },
    );
    expect(freshForeign).toEqual([FRESH]);
    expect(stranded).toEqual([OLD]);
  });

  it("strong attribution overrides the mtime — our own just-written file is still demanded", () => {
    const now = 10_000_000;
    const { stranded, freshForeign } = disqualifyFreshForeign(
      [STRONG],
      new Set([STRONG]),
      REPO,
      { statFn: statFor({ [STRONG]: now - 1_000 }), nowMs: now },
    );
    expect(stranded).toEqual([STRONG]);
    expect(freshForeign).toEqual([]);
  });

  it("an unstattable file stays stranded — over-reporting is the recoverable direction", () => {
    const { stranded, freshForeign } = disqualifyFreshForeign([OLD], new Set(), REPO, {
      statFn: statFor({}),
      nowMs: 10_000_000,
    });
    expect(stranded).toEqual([OLD]);
    expect(freshForeign).toEqual([]);
  });

  it("the report says 'leave them alone' and does not block when everything fresh is foreign", () => {
    const report = buildStopReport({
      stranded: [],
      inFlight: [],
      freshForeign: [FRESH],
      activity: null,
      totalDirty: 1,
    });
    expect(report.exitCode).toBe(0);
    const text = report.lines.join("\n");
    expect(text).toContain("RECENTLY MODIFIED");
    expect(text).toContain("recently modified by someone else, leave them alone");
    expect(text).toContain(`  ! ${FRESH}`);
    expect(text).not.toContain("Commit them before stopping");
  });
});
