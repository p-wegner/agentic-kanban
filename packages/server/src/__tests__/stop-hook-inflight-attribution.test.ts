// @gate:always-run — spawns/loads the .claude/hooks Stop hook and reads state outside its own
// import graph, so import-graph scoping cannot see it.
/**
 * #771 — the Stop hook must never tell a session to commit a live agent's mid-edit file.
 *
 * #724 gave the uncommitted check IN-FLIGHT vs STRANDED. The mechanism is right; its COVERAGE was
 * not, and the gap is PER-PATH rather than per-agent. Three field observations, all from one
 * orchestrator session:
 *
 *   1 of 3 attributed  — the other two were live #751/#753 work, proposed for commit.
 *   11 of 16           — after five agents were resumed; four of the "stranded" files were the
 *                        live #732/#745/#753 agents', one was pure #770 stat-cache noise.
 *   4 of 6             — decisive: ONE live agent's ONE coherent 774-insertion change split
 *                        4-in-flight / 2-stranded, same agent, same tickets, same minute. That
 *                        rules out liveness/resume/identity theories and leaves the write RECORD.
 *
 * Measured mechanism (137 shell commands from ten live sibling agents in this checkout): ZERO
 * writes went through a write tool. Files were patched with `python - <<'EOF' … open(p,"w") … EOF`,
 * whose target appears only in the heredoc BODY — invisible to the old scan. Meanwhile
 * `grep -n "a\|b" some/file.ts` DOES attribute, because the segment splitter cuts on the `|`
 * inside the quoted regex and loses the read verb. The two errors compose into the observed
 * instruction: a file "ours" on the strength of a read, held by nobody the hook can see, reported
 * as STRANDED.
 *
 * So: widen (harvest heredoc bodies) AND fail safe (while any subagent is live, only the PARENT's
 * own strong writes may be called stranded; anything else dirty is UNKNOWN / leave-alone).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const requireCjs = createRequire(import.meta.url);
const hookPath = resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  ".claude",
  "hooks",
  "check-uncommitted.js",
);
type Activity = {
  writtenAbs: Set<string>;
  writtenRel: Set<string>;
  inFlightAbs: Set<string>;
  inFlightRel: Set<string>;
  parentStrongAbs: Set<string>;
  parentStrongRel: Set<string>;
  liveSubagents: number;
  subagentCount: number;
  agentCalls: number;
  subagentTranscripts: number;
  subagentAuthorshipUnknown: boolean;
} | null;
type Partition = { stranded: string[]; inFlight: string[]; unknown?: string[]; weak?: string[] };
const { readSessionActivity, attributeToSession, partitionAuthored, buildStopReport } = requireCjs(
  hookPath,
) as {
  readSessionActivity: (p: string | undefined, nowMs?: number) => Activity;
  attributeToSession: (paths: string[], a: Activity, root: string) => string[];
  partitionAuthored: (paths: string[], a: Activity, root: string) => Partition;
  buildStopReport: (arg: {
    stranded: string[];
    inFlight: string[];
    unknown?: string[];
    weak?: string[];
    freshForeign?: string[];
    activity: Activity;
    totalDirty?: number;
  }) => { exitCode: number; lines: string[] };
};

const REPO = "C:/projects/andrena/agentic-kanban";
const A = "packages/server/src/worker/worker-agent-runner.ts";
const B = "packages/shared/src/lib/worker-protocol.ts";
const C = "packages/server/src/services/agent-remote.service.ts";
const D = "packages/server/src/worker/worker-repo.ts";

const edit = (p: string) => ({ type: "tool_use", name: "Edit", input: { file_path: p } });
const bash = (command: string) => ({ type: "tool_use", name: "Bash", input: { command } });
const agent = (prompt: string) => ({ type: "tool_use", name: "Agent", input: { prompt } });

/** The `python - <<'EOF' … open(p,"w") … EOF` idiom that is how agents actually patch files here. */
const heredocPatch = (rel: string) =>
  bash(
    [
      "python - <<'PYEOF'",
      "import io",
      `p="${rel}"`,
      's=io.open(p,encoding="utf-8").read()',
      's=s.replace("old","new")',
      'io.open(p,"w",encoding="utf-8").write(s)',
      "PYEOF",
    ].join("\n"),
  );

describe("check-uncommitted hook — fail-safe attribution while agents are live (#771)", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ak-771-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * A parent transcript plus N subagent transcripts, in Claude Code's real on-disk layout
   * (`<dir>/parent.jsonl` beside `<dir>/parent/subagents/agent-<id>.jsonl`). A subagent whose
   * `closed` is false ends on an unanswered tool_use, i.e. is still running.
   */
  async function session(opts: {
    parentBlocks?: unknown[];
    subagents: { id: string; blocks: unknown[]; closed?: boolean }[];
  }): Promise<string> {
    const p = join(dir, "parent.jsonl");
    const parentLines: string[] = [];
    for (const s of opts.subagents) {
      parentLines.push(JSON.stringify({ cwd: REPO, message: { content: [agent("do the work")] } }));
      parentLines.push(
        JSON.stringify({ cwd: REPO, toolUseResult: { agentId: s.id, status: "async_launched" } }),
      );
    }
    for (const b of opts.parentBlocks ?? []) {
      parentLines.push(
        JSON.stringify({
          cwd: REPO,
          type: "assistant",
          message: { role: "assistant", stop_reason: "tool_use", content: [b] },
        }),
      );
    }
    await writeFile(p, parentLines.join("\n") + "\n");
    const subDir = join(dir, "parent", "subagents");
    await mkdir(subDir, { recursive: true });
    for (const s of opts.subagents) {
      const lines = s.blocks.map((b) =>
        JSON.stringify({
          cwd: REPO,
          agentId: s.id,
          type: "assistant",
          message: { role: "assistant", stop_reason: "tool_use", content: [b] },
        }),
      );
      if (s.closed) {
        lines.push(
          JSON.stringify({
            cwd: REPO,
            agentId: s.id,
            type: "assistant",
            message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] },
          }),
        );
      }
      await writeFile(join(subDir, `agent-${s.id}.jsonl`), lines.join("\n") + "\n");
    }
    return p;
  }

  it("widens: a file patched only through a python heredoc is IN FLIGHT, not invisible", async () => {
    // The measured dominant write idiom. Before the widening the target appeared nowhere in the
    // scan's output, so the live agent held a file the hook could not see it holding.
    const p = await session({ subagents: [{ id: "aliveheredoc", blocks: [heredocPatch(A)] }] });
    const activity = readSessionActivity(p);
    expect(activity?.liveSubagents).toBe(1);
    expect(attributeToSession([A, B], activity, REPO)).toEqual([A]);
    expect(partitionAuthored([A, B], activity, REPO)).toMatchObject({ stranded: [], inFlight: [A] });
  });

  it("the 4-of-6 split does not happen: mixed Edit + heredoc writes are ALL in flight", async () => {
    // The decisive field case, reconstructed: one live agent, one change, four paths written with
    // a write tool and two through a heredoc. Every one of the six must be in flight.
    const p = await session({
      subagents: [
        {
          id: "alive783784",
          blocks: [edit(`${REPO}/${C}`), edit(`${REPO}/${D}`), heredocPatch(A), heredocPatch(B)],
        },
      ],
    });
    const activity = readSessionActivity(p);
    const part = partitionAuthored([A, B, C, D], activity, REPO);
    expect(part.stranded).toEqual([]);
    expect(part.inFlight.sort()).toEqual([A, B, C, D].sort());
    expect(buildStopReport({ ...part, activity, totalDirty: 4 }).exitCode).toBe(0);
  });

  it("two live agents whose writes the scan CANNOT see: neither file is called stranded", async () => {
    // The ticket's own acceptance case. The parent only READ both files — but `grep -n "a\|b" f`
    // attributes anyway (the splitter cuts the quoted `|`, losing the read verb), which is how a
    // file the parent never wrote became "ours" and then "stranded".
    const p = await session({
      parentBlocks: [bash(`grep -n "export\\|import" ${A}`), bash(`grep -n "export\\|import" ${B}`)],
      subagents: [
        { id: "alivereadonly1", blocks: [bash(`cat ${A}`)] },
        { id: "alivereadonly2", blocks: [bash(`cat ${B}`)] },
      ],
    });
    const activity = readSessionActivity(p);
    expect(activity?.liveSubagents).toBe(2);
    // Weakly attributed to us (unchanged, #720's noise-not-silence direction) …
    expect(attributeToSession([A, B], activity, REPO).sort()).toEqual([A, B].sort());
    // … but NEVER proposed for commit while agents are live.
    const part = partitionAuthored([A, B], activity, REPO);
    expect(part.stranded).toEqual([]);
    expect(part.unknown?.sort()).toEqual([A, B].sort());

    const report = buildStopReport({ ...part, activity, totalDirty: 2 });
    expect(report.exitCode).toBe(0);
    const text = report.lines.join("\n");
    expect(text).toContain("UNKNOWN");
    expect(text).toContain("could not be attributed");
    expect(text).toContain(`  ? ${A}`);
    // The dangerous instruction must be absent entirely, not merely softened.
    expect(text).not.toContain("Commit them before stopping");
    expect(text).not.toContain(`  - ${A}`);
  });

  it("states HOW MANY dirty files it could not attribute, so the gap is visible", async () => {
    const p = await session({
      parentBlocks: [edit(`${REPO}/${A}`)],
      subagents: [{ id: "alivecounter", blocks: [heredocPatch(B)] }],
    });
    const activity = readSessionActivity(p);
    // C and D are dirty but belong to some other session entirely.
    const part = partitionAuthored([A, B, C, D], activity, REPO);
    const text = buildStopReport({ ...part, activity, totalDirty: 4 }).lines.join("\n");
    expect(text).toMatch(/2 of 4 dirty source file\(s\) could not be attributed/);
  });

  it("keeps the real signal: the PARENT's own strong write is still stranded while agents run", async () => {
    // The fail-safe must not become silence. A file this session wrote with a write tool (or a
    // redirect, or `sed -i`) is ours beyond doubt — it is still demanded, and the stop still blocks.
    const p = await session({
      parentBlocks: [edit(`${REPO}/${A}`), bash(`sed -i 's/a/b/' ${B}`)],
      subagents: [{ id: "alivebystander", blocks: [heredocPatch(C)] }],
    });
    const activity = readSessionActivity(p);
    const part = partitionAuthored([A, B, C], activity, REPO);
    expect(part.stranded.sort()).toEqual([A, B].sort());
    expect(part.inFlight).toEqual([C]);
    const report = buildStopReport({ ...part, activity, totalDirty: 3 });
    expect(report.exitCode).toBe(1);
    expect(report.lines.join("\n")).toContain("Commit the STRANDED files listed above");
  });

  it("with NO live subagent, weak evidence is REPORTED but never instructed (#884 supersedes #771 here)", async () => {
    // #771 let everything weakly attributed become STRANDED again once nobody was live — but the
    // weak set is a guess (39% of its 10,286 entries measured as non-paths in #884), and a guess
    // must never carry "Commit them before stopping". Weak-only files are now a soft
    // "dirty, possibly yours — verify" mention, and the stop is not blocked by them.
    const p = await session({
      parentBlocks: [bash(`grep -n "export\\|import" ${A}`)],
      subagents: [{ id: "finishedagent", blocks: [heredocPatch(B)], closed: true }],
    });
    const activity = readSessionActivity(p);
    expect(activity?.liveSubagents).toBe(0);
    const part = partitionAuthored([A, B], activity, REPO) as Partition & { weak?: string[] };
    expect(part.stranded).toEqual([]);
    expect(part.weak?.sort()).toEqual([A, B].sort());
    expect(part.unknown ?? []).toEqual([]);
    const report = buildStopReport({ ...part, activity, totalDirty: 2 });
    expect(report.exitCode).toBe(0);
    const text = report.lines.join("\n");
    expect(text).toContain("POSSIBLY YOURS");
    expect(text).not.toContain("Commit them before stopping");
  });

  it("end to end: the hook SCRIPT exits 0 and demands nothing while a live agent holds the file", async () => {
    // The whole point of the suite, through the wired script rather than its exports: a real git
    // repo, a real dirty source file, a real transcript recording a live subagent that patched it
    // through a heredoc. Before the fix this exited 1 with "Commit them before stopping".
    const repo = await mkdtemp(join(tmpdir(), "ak-771-repo-"));
    try {
      const runGit = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
      runGit(["init", "-q", "-b", "main"]);
      runGit(["config", "user.email", "t@e.com"]);
      runGit(["config", "user.name", "T"]);
      const abs = join(repo, A);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, "export const runner = 1;\n");
      runGit(["add", "-A"]);
      runGit(["commit", "-q", "-m", "seed"]);
      writeFileSync(abs, "export const runner = 2; // live agent, mid-edit\n");

      mkdirSync(join(repo, ".claude", "hooks"), { recursive: true });
      const copied = join(repo, ".claude", "hooks", "check-uncommitted.js");
      writeFileSync(copied, readFileSync(hookPath, "utf8"));

      // The transcript's cwd must be the FIXTURE repo, so the heredoc's relative path resolves there.
      const parent = join(dir, "e2e.jsonl");
      const repoFwd = repo.replace(/\\/g, "/");
      await writeFile(
        parent,
        [
          JSON.stringify({ cwd: repoFwd, message: { content: [agent("patch it")] } }),
          JSON.stringify({ cwd: repoFwd, toolUseResult: { agentId: "alivee2e", status: "async_launched" } }),
        ].join("\n") + "\n",
      );
      const subDir = join(dir, "e2e", "subagents");
      await mkdir(subDir, { recursive: true });
      await writeFile(
        join(subDir, "agent-alivee2e.jsonl"),
        JSON.stringify({
          cwd: repoFwd,
          type: "assistant",
          message: { role: "assistant", stop_reason: "tool_use", content: [heredocPatch(A)] },
        }) + "\n",
      );

      const result = spawnSync(process.execPath, [copied], {
        cwd: repo,
        input: JSON.stringify({ session_id: "no-such-session", transcript_path: parent }),
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("IN FLIGHT");
      expect(result.stderr).not.toContain("Commit them before stopping");
      expect(result.stderr).not.toContain(`  - ${A}`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("a subagent's file is not demanded while OTHER agents are live, even after it finished", async () => {
    // A closed turn can mean "done" or "between turns / resumed". Waiting one Stop costs a delay;
    // guessing wrong commits a mid-edit file under the wrong author, which is unrewritable.
    const p = await session({
      subagents: [
        { id: "finishedone1", blocks: [edit(`${REPO}/${A}`)], closed: true },
        { id: "stillrunning", blocks: [edit(`${REPO}/${B}`)] },
      ],
    });
    const activity = readSessionActivity(p);
    expect(activity?.liveSubagents).toBe(1);
    const part = partitionAuthored([A, B], activity, REPO);
    expect(part.stranded).toEqual([]);
    expect(part.inFlight).toEqual([B]);
    expect(part.unknown).toEqual([A]);
    expect(buildStopReport({ ...part, activity, totalDirty: 2 }).exitCode).toBe(0);
  });
});
