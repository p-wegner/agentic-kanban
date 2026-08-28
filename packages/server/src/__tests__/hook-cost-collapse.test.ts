// @gate:always-run — reads .claude/settings.json + spawns the live hook scripts outside src/; imports nothing it checks (#538).
/**
 * #914 — two costs paid on every tool call, both removed.
 *
 *  1. THREE `Bash|PowerShell` PreToolUse entries (runner, vital-file guard, cross-worktree
 *     guard) = three node cold starts per shell call. The other two now run IN-PROCESS
 *     through the runner, as validate-command-safety already did.
 *  2. `check-uncommitted.js` re-parsed the full session transcript plus up to 200 subagent
 *     transcripts on every call, and `applyInFlightAwareness` called it again per failing
 *     check. A per-file byte offset plus a memoized result makes a long session stop timing
 *     out exactly where the check matters.
 *
 * The fail-closed semantics of the two collapsed guards must survive the move — that is the
 * part a "make it faster" change is most likely to quietly break, so it is asserted here
 * rather than assumed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const HOOKS_DIR = join(REPO_ROOT, ".claude", "hooks");

interface SettingsHookEntry {
  matcher?: string;
  hooks?: { command?: string }[];
}

function preToolUseEntries(): SettingsHookEntry[] {
  const settings = JSON.parse(readFileSync(join(REPO_ROOT, ".claude", "settings.json"), "utf8")) as {
    hooks?: { PreToolUse?: SettingsHookEntry[] };
  };
  return settings.hooks?.PreToolUse ?? [];
}

describe("PreToolUse shell spawns are collapsed to one (#914)", () => {
  it("wires exactly ONE Bash|PowerShell command hook — the runner", () => {
    const shellCommands = preToolUseEntries()
      .filter((e) => /Bash|PowerShell/.test(e.matcher ?? ""))
      .flatMap((e) => (e.hooks ?? []).map((h) => h.command ?? ""));

    // The acceptance criterion, stated as a count: one PreToolUse record per shell call.
    expect(shellCommands).toHaveLength(1);
    expect(shellCommands[0]).toContain("smart-hooks-runner.js PreToolUse");
  });

  it("keeps the cross-worktree guard on the WRITE matcher, which the runner does not serve", () => {
    // `handlePreToolUse` returns early for anything that is not a shell tool, so collapsing
    // this entry too would silently drop the Write/Edit vector.
    const writeCommands = preToolUseEntries()
      .filter((e) => (e.matcher ?? "").includes("Write") && (e.matcher ?? "").includes("Edit"))
      .flatMap((e) => (e.hooks ?? []).map((h) => h.command ?? ""));
    expect(writeCommands.some((c) => c.includes("prevent-cross-worktree-writes.js"))).toBe(true);
  });

  it("lists both collapsed guards in the runner's own check config, so the collapse is not a deletion", () => {
    const config = JSON.parse(readFileSync(join(HOOKS_DIR, "smart-hooks-config.json"), "utf8")) as {
      hooks?: { PreToolUse?: { command?: string; alwaysRun?: boolean }[] };
    };
    const checks = config.hooks?.PreToolUse ?? [];
    for (const guard of ["vital-file-guard.js", "prevent-cross-worktree-writes.js"]) {
      const check = checks.find((c) => c.command?.includes(guard));
      expect(check, guard).toBeDefined();
      // alwaysRun marks it a SAFETY check, which is what exempts it from the #913 posture
      // and capacity gates. Without it, a busy box would silently disarm the guard.
      expect(check?.alwaysRun, guard).toBe(true);
    }
  });

  it("the runner knows how to run both guards in-process", () => {
    const runnerSource = readFileSync(join(HOOKS_DIR, "smart-hooks-runner.js"), "utf8");
    // The in-process table is what makes the collapsed entries cost one process instead of
    // three; without an entry here the runner would spawn them and buy nothing.
    expect(runnerSource).toMatch(/"vital-file-guard\.js":\s*\{/);
    expect(runnerSource).toMatch(/"prevent-cross-worktree-writes\.js":\s*\{/);
  });
});

describe("the collapsed guards keep their decision core (#914)", () => {
  it("vital-file-guard exposes evaluateCommand and still blocks a destructive command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ak-914-vital-"));
    try {
      await mkdir(join(dir, ".claude", "hooks"), { recursive: true });
      await writeFile(join(dir, "app.db"), "data");
      await writeFile(join(dir, ".claude", "hooks", "vital-files.json"), JSON.stringify(["app.db"]));

      const mod = require(join(HOOKS_DIR, "vital-file-guard.js")) as {
        evaluateCommand: (input: unknown) => { decision: string; reason?: string; stderr: string[] };
      };
      const verdict = mod.evaluateCommand({
        tool_name: "Bash",
        tool_input: { command: "rm app.db" },
        cwd: dir,
      });
      expect(verdict.decision).toBe("block");
      expect(verdict.reason).toContain("app.db");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cross-worktree guard exposes evaluateToolCall and still fails OPEN-but-loud on an uninspectable input", () => {
    const mod = require(join(HOOKS_DIR, "prevent-cross-worktree-writes.js")) as {
      evaluateToolCall: (input: unknown) => { decision: string; stderr: string[] };
    };
    // #391's contract: never wedge an agent on a parse error, but say so with the stable
    // marker rather than looking like a pass.
    const verdict = mod.evaluateToolCall(null);
    expect(verdict.decision).toBe("allow");
    expect(verdict.stderr.join("\n")).toContain("ALLOWED WITHOUT CHECKING");
  });

  it("both scripts still work STANDALONE, which is how Codex and Pi invoke them", () => {
    for (const script of ["vital-file-guard.js", "prevent-cross-worktree-writes.js"]) {
      const result = spawnSync(process.execPath, [join(HOOKS_DIR, script)], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } }),
        encoding: "utf8",
        cwd: REPO_ROOT,
      });
      expect(result.status, script).toBe(0);
    }
  });
});

describe("check-uncommitted parses only the appended tail (#914)", () => {
  const hook = require(join(HOOKS_DIR, "check-uncommitted.js")) as {
    parseTranscriptCached: (path: string, sink: Record<string, unknown>) => boolean;
    transcriptParseCache: Map<string, { size: number; offset: number }>;
  };

  let dir: string;
  let transcript: string;

  /** One transcript line recording a Write of `file`. */
  function writeEntry(file: string) {
    return (
      JSON.stringify({
        type: "assistant",
        cwd: "/repo",
        message: { content: [{ type: "tool_use", name: "Write", input: { file_path: file } }] },
      }) + "\n"
    );
  }

  function freshSink() {
    return {
      writtenAbs: new Set<string>(),
      writtenRel: new Set<string>(),
      strongAbs: new Set<string>(),
      strongRel: new Set<string>(),
      agentCalls: 0,
      agentIds: new Set<string>(),
      turnClosed: false,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ak-914-transcript-"));
    transcript = join(dir, "session.jsonl");
    hook.transcriptParseCache.clear();
    writeFileSync(transcript, writeEntry("/repo/a.ts"));
  });

  afterEach(async () => {
    hook.transcriptParseCache.clear();
    await rm(dir, { recursive: true, force: true });
  });

  it("advances the byte offset instead of re-reading from zero", () => {
    const first = freshSink();
    expect(hook.parseTranscriptCached(transcript, first)).toBe(true);
    const afterFirst = hook.transcriptParseCache.get(transcript)!;
    expect(afterFirst.offset).toBeGreaterThan(0);

    appendFileSync(transcript, writeEntry("/repo/b.ts"));
    const second = freshSink();
    expect(hook.parseTranscriptCached(transcript, second)).toBe(true);

    // The answer still covers the WHOLE file — an incremental parse that lost the prefix
    // would silently stop attributing early work to this session.
    expect([...second.writtenAbs]).toEqual(expect.arrayContaining(["/repo/a.ts", "/repo/b.ts"]));
    expect(hook.transcriptParseCache.get(transcript)!.offset).toBeGreaterThan(afterFirst.offset);
  });

  it("returns the same answer as a cold parse when nothing changed", () => {
    appendFileSync(transcript, writeEntry("/repo/b.ts"));
    const cold = freshSink();
    hook.parseTranscriptCached(transcript, cold);

    const warm = freshSink();
    hook.parseTranscriptCached(transcript, warm);
    expect([...warm.writtenAbs].sort()).toEqual([...cold.writtenAbs].sort());
  });

  it("re-parses from zero when the file was TRUNCATED, so a stale prefix is never trusted", () => {
    const first = freshSink();
    hook.parseTranscriptCached(transcript, first);
    expect([...first.writtenAbs]).toContain("/repo/a.ts");

    // Rotation/truncation: the remembered prefix is no longer a prefix of this file.
    truncateSync(transcript, 0);
    writeFileSync(transcript, writeEntry("/repo/c.ts"));

    const second = freshSink();
    hook.parseTranscriptCached(transcript, second);
    expect([...second.writtenAbs]).toEqual(["/repo/c.ts"]);
    expect([...second.writtenAbs]).not.toContain("/repo/a.ts");
  });

  it("does not remember a half-flushed final line, and still reports it", () => {
    // A live transcript's last line is routinely partial. Remembering it would corrupt the
    // next parse; ignoring it in the ANSWER would under-report this session's own writes.
    const partial = JSON.stringify({
      type: "assistant",
      cwd: "/repo",
      message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/repo/d.ts" } }] },
    });
    appendFileSync(transcript, partial); // deliberately no trailing newline

    const sink = freshSink();
    hook.parseTranscriptCached(transcript, sink);
    expect([...sink.writtenAbs]).toEqual(expect.arrayContaining(["/repo/a.ts", "/repo/d.ts"]));

    // The offset stops at the last complete newline, so the partial line is re-read.
    const entry = hook.transcriptParseCache.get(transcript)!;
    expect(entry.offset).toBeLessThan(entry.size);
  });
});
