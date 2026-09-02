// @gate:always-run — loads and spawns the .claude/hooks runner from outside its own package,
// so it reaches state that no import of a changed source file leads to.
/**
 * #759 — the compile check must not demand you fix a live agent's half-written file.
 *
 * #724 taught the uncommitted-files check to tell IN-FLIGHT subagent work from STRANDED work; the
 * typecheck check in the same hook chain learned nothing, so it reproduced the failure #724 fixed.
 * Observed twice in one session, with the transition between the two states captured:
 *
 *   src/services/agent-remote.service.ts(762,3): error TS2739: ... is missing the following
 *     properties from type 'RemoteAgentService': remoteSessionInfo, requestRepoOp
 *   -> "Fix the issues before stopping."
 *
 * `remoteSessionInfo` and `requestRepoOp` were exactly the two protocol operations a LIVE agent was
 * mid-way through adding. No commit landed on that file in between, and the next run of the same
 * check passed — the agent simply finished writing it. So the break existed in no committed state,
 * and the instruction was to edit a file another agent held.
 *
 * The rule under test: a compile error is excused ONLY when every file it names is uncommitted and
 * either held by a live subagent (IN FLIGHT) or unattributable while agents are live (#771's
 * UNKNOWN bucket). A committed-state break, or one in a file nobody live is holding, still fails —
 * and the message always names which case it took.
 */
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
// #1006 — see the helper: an EPERM from THIS fixture shape is Windows' async handle close after
// the synchronous git/runner children exited, not a leaked holder worth failing the gate over.
import { rmFixtureDir } from "./helpers/rm-or-report-holder.js";

const requireCjs = createRequire(import.meta.url);
const HOOKS_DIR = resolve(import.meta.dirname, "..", "..", "..", "..", ".claude", "hooks");
const runnerPath = join(HOOKS_DIR, "smart-hooks-runner.js");

type Verdict = { block: boolean; summary: string };
type HookStub = {
  trackedSourceChanges: (cwd: string) => { all: string[] };
  readSessionActivity: (p: string) => { liveSubagents: number } | null;
  partitionAuthored: (
    paths: string[],
    a: unknown,
    root: string,
  ) => { stranded: string[]; inFlight: string[]; unknown?: string[] };
};
const { parseCompileErrorFiles, compileErrorNamesPath, classifyCompileFailure } = requireCjs(
  runnerPath,
) as {
  parseCompileErrorFiles: (output: string) => string[];
  compileErrorNamesPath: (errorFile: string, dirtyPath: string) => boolean;
  classifyCompileFailure: (
    output: string,
    deps: { loadHook: () => HookStub | null; projectDir: string; transcriptPath?: string },
  ) => Verdict;
};

const REPO = "C:/projects/andrena/agentic-kanban";
const REMOTE = "packages/server/src/services/agent-remote.service.ts";
/** The field observation, verbatim. */
const OBSERVED_OUTPUT = [
  "> agentic-kanban@ typecheck C:\\projects\\andrena\\agentic-kanban",
  "src/services/agent-remote.service.ts(762,3): error TS2739: Type '{ launch: ... }' is missing the following properties from type 'RemoteAgentService': remoteSessionInfo, requestRepoOp",
  "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command failed with exit code 2: tsc --noEmit",
].join("\n");

function hookStub(opts: {
  dirty: string[];
  live: number;
  inFlight?: string[];
  unknown?: string[];
  stranded?: string[];
}): HookStub {
  return {
    trackedSourceChanges: () => ({ all: opts.dirty }),
    readSessionActivity: () => ({ liveSubagents: opts.live }),
    partitionAuthored: () => ({
      stranded: opts.stranded ?? [],
      inFlight: opts.inFlight ?? [],
      unknown: opts.unknown,
    }),
  };
}

const deps = (hook: HookStub | null) => ({
  loadHook: () => hook,
  projectDir: REPO,
  transcriptPath: "C:/transcripts/parent.jsonl",
});

describe("smart-hooks runner — compile errors are attributed before they are demanded (#759)", () => {
  it("parses tsc error files out of pnpm-prefixed output", () => {
    expect(parseCompileErrorFiles(OBSERVED_OUTPUT)).toEqual([
      "src/services/agent-remote.service.ts",
    ]);
    // Two errors in one file are one file; a warning-free run yields nothing.
    expect(parseCompileErrorFiles("a/b.ts(1,1): error TS1: x\na/b.ts(2,2): error TS2: y")).toEqual([
      "a/b.ts",
    ]);
    expect(parseCompileErrorFiles("all good")).toEqual([]);
  });

  it("matches a package-relative tsc path against a repo-relative dirty path", () => {
    // tsc runs per package, so the two strings share only a suffix.
    expect(compileErrorNamesPath("src/services/agent-remote.service.ts", REMOTE)).toBe(true);
    expect(compileErrorNamesPath(REMOTE, REMOTE)).toBe(true);
    expect(compileErrorNamesPath("src/services/other.ts", REMOTE)).toBe(false);
  });

  it("the observed case: the only broken file is a live agent's, so the stop is NOT blocked", () => {
    const verdict = classifyCompileFailure(
      OBSERVED_OUTPUT,
      deps(hookStub({ dirty: [REMOTE], live: 9, inFlight: [REMOTE] })),
    );
    expect(verdict.block).toBe(false);
    expect(verdict.summary).toContain("case: IN FLIGHT");
    expect(verdict.summary).toContain(REMOTE);
    // Never the instruction that caused the incident.
    expect(verdict.summary).not.toMatch(/Fix the issues/i);
  });

  it("#771's UNKNOWN bucket excuses too — an unattributable dirty file is nobody's to fix", () => {
    const verdict = classifyCompileFailure(
      OBSERVED_OUTPUT,
      deps(hookStub({ dirty: [REMOTE], live: 3, unknown: [REMOTE] })),
    );
    expect(verdict.block).toBe(false);
    expect(verdict.summary).toContain("case: IN FLIGHT");
  });

  it("a COMMITTED-state break still fails: the file is not dirty at all", () => {
    // The real signal. Nothing is uncommitted, so no live agent can be mid-edit in it.
    const verdict = classifyCompileFailure(
      OBSERVED_OUTPUT,
      deps(hookStub({ dirty: [], live: 9 })),
    );
    expect(verdict.block).toBe(true);
    expect(verdict.summary).toContain("case: YOURS (mixed)");
    expect(verdict.summary).toContain("src/services/agent-remote.service.ts");
  });

  it("a break in a file nobody live is holding still fails, and names the mixed case", () => {
    const other = "packages/server/src/services/mine.ts";
    const verdict = classifyCompileFailure(
      [OBSERVED_OUTPUT, "src/services/mine.ts(5,1): error TS2304: Cannot find name 'x'."].join("\n"),
      deps(hookStub({ dirty: [REMOTE, other], live: 2, inFlight: [REMOTE], stranded: [other] })),
    );
    expect(verdict.block).toBe(true);
    expect(verdict.summary).toContain("case: YOURS (mixed)");
    expect(verdict.summary).toContain("src/services/mine.ts");
    // The in-flight one is still reported, as leave-alone rather than as a demand.
    expect(verdict.summary).toContain("in flight");
  });

  it("with no live subagent every break is yours — the case is named, and it blocks", () => {
    const verdict = classifyCompileFailure(
      OBSERVED_OUTPUT,
      deps(hookStub({ dirty: [REMOTE], live: 0 })),
    );
    expect(verdict.block).toBe(true);
    expect(verdict.summary).toContain("case: YOURS");
    expect(verdict.summary).toContain("no live subagent");
  });

  it("fails CLOSED when it cannot classify: unparseable output, or no detection available", () => {
    const unparseable = classifyCompileFailure("Some other tool exploded", deps(hookStub({ dirty: [], live: 0 })));
    expect(unparseable.block).toBe(true);
    expect(unparseable.summary).toContain("UNCLASSIFIED");

    const noHook = classifyCompileFailure(OBSERVED_OUTPUT, deps(null));
    expect(noHook.block).toBe(true);
    expect(noHook.summary).toContain("NO IN-FLIGHT DATA");

    const throwing = classifyCompileFailure(OBSERVED_OUTPUT, {
      loadHook: () => {
        throw new Error("module missing");
      },
      projectDir: REPO,
      transcriptPath: undefined,
    });
    expect(throwing.block).toBe(true);
    expect(throwing.summary).toContain("NO IN-FLIGHT DATA");
  });
});

describe("smart-hooks runner — end to end Stop with a failing compile check (#759)", () => {
  /**
   * A fixture repo with the runner's own hooks copied in, one dirty source file, a config whose
   * single Stop check prints a tsc error for that file and exits 1, and a transcript recording a
   * live subagent that wrote it. `held: false` omits the subagent, so nobody is holding the file.
   */
  function fixture(held: boolean): { dir: string; transcript: string } {
    const dir = mkdtempSync(join(tmpdir(), "ak-759-"));
    const rel = "packages/server/src/services/agent-remote.service.ts";
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
    // #913 added hook-posture.js + machine-capacity.js to the runner's module set. They load
    // defensively, but a fixture missing them would silently exercise the pre-#913 chain.
    for (const f of [
      "smart-hooks-runner.js",
      "check-uncommitted.js",
      "git-topology-cache.js",
      "hook-posture.js",
      "machine-capacity.js",
    ]) {
      writeFileSync(join(dir, ".claude", "hooks", f), readFileSync(join(HOOKS_DIR, f), "utf8"));
    }
    writeFileSync(
      join(dir, ".claude", "hooks", "smart-hooks-config.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              name: "TypeScript typecheck",
              command:
                `node -e "console.log('src/services/agent-remote.service.ts(762,3): error TS2739: missing remoteSessionInfo, requestRepoOp'); process.exit(1)"`,
              enabled: true,
              blocking: true,
              timeout: 30,
            },
          ],
        },
      }),
    );
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@e.com"]);
    git(["config", "user.name", "T"]);
    writeFileSync(abs, "export const remote = 1;\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "seed"]);
    writeFileSync(abs, "export const remote = 2; // half-written\n");

    const dirFwd = dir.replace(/\\/g, "/");
    const transcript = join(dir, "parent.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ cwd: dirFwd, message: { content: [{ type: "tool_use", name: "Agent", input: { prompt: "go" } }] } }),
        JSON.stringify({ cwd: dirFwd, toolUseResult: { agentId: "alive759", status: "async_launched" } }),
      ].join("\n") + "\n",
    );
    if (held) {
      const subDir = join(dir, "parent", "subagents");
      mkdirSync(subDir, { recursive: true });
      writeFileSync(
        join(subDir, "agent-alive759.jsonl"),
        JSON.stringify({
          cwd: dirFwd,
          type: "assistant",
          message: {
            role: "assistant",
            stop_reason: "tool_use",
            content: [{ type: "tool_use", name: "Edit", input: { file_path: `${dirFwd}/${rel}` } }],
          },
        }) + "\n",
      );
    }
    // The Stop path only runs file-pattern checks when files were edited this session.
    writeFileSync(
      join(dir, ".claude", "hooks", ".smart-hooks-state.json"),
      JSON.stringify({ editedFiles: [rel] }),
    );
    return { dir, transcript };
  }

  function runStop(dir: string, transcript: string) {
    return spawnSync(process.execPath, [join(dir, ".claude", "hooks", "smart-hooks-runner.js"), "Stop"], {
      cwd: dir,
      input: JSON.stringify({ stop_hook_active: false, session_id: "no-such-session", transcript_path: transcript }),
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: dir,
        // #1006 — pin BOTH policy gates, or this suite asserts a machine reading.
        //
        // The fixture's single check is named "TypeScript typecheck", so `classifyCheck` puts it
        // in the `typecheck` bucket, and under the default `standard` posture that bucket is
        // capacity-gated. `capacityHold` then reads `os.freemem()`: below its 2GB floor the check
        // is SKIPPED (advisory, success) and the runner exits 0 — so the "still blocks" case below
        // fails with `status 0 instead of 2` on a loaded box and passes on a quiet one, with no
        // code change in between. That is exactly what happened to gate run merge-6dbc0e62-5.
        //
        // `SMART_HOOKS_FORCE=1` is the documented escape hatch for "a deliberate run must not be
        // second-guessed by a heuristic", and `SMART_HOOKS_POSTURE=standard` pins the other gate so
        // the worktree's own ticket-context posture can never reach in either. Neither weakens what
        // is under test: this suite is about ATTRIBUTION of a compile error, and both gates sit
        // upstream of the classifier it exercises.
        SMART_HOOKS_FORCE: "1",
        SMART_HOOKS_POSTURE: "standard",
      },
    });
  }

  it("does not block when the broken file is a live subagent's mid-edit work", () => {
    const { dir, transcript } = fixture(true);
    try {
      const result = runStop(dir, transcript);
      expect(result.stderr).toContain("case: IN FLIGHT");
      expect(result.stdout).not.toContain("CHECKS FAILED");
      expect(result.status).toBe(0);
    } finally {
      rmFixtureDir(dir);
    }
  });

  it("still blocks when nobody live is holding the broken file", () => {
    const { dir, transcript } = fixture(false);
    try {
      const result = runStop(dir, transcript);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain("CHECKS FAILED");
      expect(result.stderr).toContain("case: YOURS");
    } finally {
      rmFixtureDir(dir);
    }
  });
});
