import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * #208 tail: a git call with NO timeout can block forever, and the one that did took the
 * whole monitor down with it (see `DEFAULT_GIT_TIMEOUT_MS`). These lock the two properties
 * that make an unbounded hang impossible: every buffered git spawn carries a default
 * wall-clock timeout, and it never waits on an interactive credential prompt.
 */
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: null, o: string, s: string) => void) => {
    cb(null, "", "");
    return { stdin: { end: vi.fn() } };
  }),
  execFileSync: vi.fn(() => ""),
  spawn: vi.fn(() => ({})),
}));

import { execFile, execFileSync, spawn } from "node:child_process";
import { DEFAULT_GIT_TIMEOUT_MS, gitExec, gitExecSync, gitStream } from "../src/lib/git-exec.js";

type SpawnOpts = { timeout?: number; env?: Record<string, string | undefined> };

/** Options object passed to the mocked child_process function on its last call. */
function lastOpts(fn: unknown): SpawnOpts {
  const calls = vi.mocked(fn as (...a: unknown[]) => unknown).mock.calls;
  return calls[calls.length - 1][2] as SpawnOpts;
}

describe("git-exec spawn defaults", () => {
  beforeEach(() => {
    vi.mocked(execFile).mockClear();
    vi.mocked(execFileSync).mockClear();
    vi.mocked(spawn).mockClear();
  });

  it("applies a default wall-clock timeout to gitExec when the caller sets none", async () => {
    await gitExec(["status", "--porcelain"], { cwd: "/repo" });
    expect(lastOpts(execFile).timeout).toBe(DEFAULT_GIT_TIMEOUT_MS);
  });

  it("lets an explicit timeout override the default", async () => {
    await gitExec(["fetch"], { cwd: "/repo", timeout: 1234 });
    expect(lastOpts(execFile).timeout).toBe(1234);
  });

  it("applies the default timeout to gitExecSync too", () => {
    gitExecSync(["rev-parse", "HEAD"], { cwd: "/repo" });
    expect(lastOpts(execFileSync).timeout).toBe(DEFAULT_GIT_TIMEOUT_MS);
  });

  it("disables git's interactive prompts on every spawn path", async () => {
    await gitExec(["ls-remote"], { cwd: "/repo" });
    gitExecSync(["ls-remote"], { cwd: "/repo" });
    gitStream(["upload-pack", "--stateless-rpc", "/repo"]);
    for (const fn of [execFile, execFileSync, spawn]) {
      expect(lastOpts(fn).env?.GIT_TERMINAL_PROMPT).toBe("0");
    }
  });

  it("MERGES the prompt guard into a caller-supplied env instead of replacing it", async () => {
    await gitExec(["hash-object", "-w", "--stdin"], { cwd: "/repo", env: { GIT_INDEX_FILE: "/tmp/idx" } });
    const env = lastOpts(execFile).env ?? {};
    expect(env.GIT_INDEX_FILE).toBe("/tmp/idx");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});
