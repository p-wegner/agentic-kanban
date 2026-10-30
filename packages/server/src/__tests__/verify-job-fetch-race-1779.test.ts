// #1779: two verify jobs placed into one worker clone at once both fetch and run; a lost ref-lock race is retried.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import type { VerifyJobFrame } from "@agentic-kanban/shared/lib/worker-verify-protocol";

const state = { activeFetches: 0, maxActiveFetches: 0, fetches: 0, failFirstFetch: false };
vi.mock("@agentic-kanban/shared/lib/git-exec", () => {
  const exec = async (args: string[]) => {
    if (args[0] === "fetch") {
      state.fetches++;
      state.activeFetches++;
      state.maxActiveFetches = Math.max(state.maxActiveFetches, state.activeFetches);
      await new Promise((r) => setTimeout(r, 20));
      state.activeFetches--;
      if (state.failFirstFetch && state.fetches === 1) {
        return { stdout: "", stderr: "error: cannot lock ref 'refs/remotes/origin/x': is at a but expected b", code: 1, error: new Error("x") };
      }
    }
    if (args[0] === "rev-parse") return { stdout: "a".repeat(40) + "\n", stderr: "", code: 0, error: null };
    return { stdout: "", stderr: "", code: 0, error: null };
  };
  return {
    gitExec: exec,
    gitExecOrThrow: async (args: string[], o: unknown) => {
      const r = await exec(args);
      if (r.error) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
      return r.stdout;
    },
  };
});

import { createDaemonVerifyRunner } from "../worker/worker-verify-runner.js";

const ROOT = mkdtempSync(join(tmpdir(), "ak-verify-fetch-race-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const SHA = "a".repeat(40);

const job = (jobId: string): VerifyJobFrame => ({
  type: "verify_job", jobId, sha: SHA, branch: "feature/x", kind: "workspace-gate", tier: "impact", script: "pnpm verify", setupScript: "true", timeoutMs: 1000,
  auth: { projectId: "p1", gitPort: 9, gitToken: "t", branch: "feature/x", incomingRef: "" },
});

async function runTwo() {
  mkdirSync(join(ROOT, "repos", "p1", ".git"), { recursive: true });
  const results: Array<Extract<WorkerToBoardMessage, { type: "verify_result" }>> = [];
  const runner = createDaemonVerifyRunner({
    workRoot: ROOT, boardUrl: () => "http://board:1", slots: 2, ramGb: 32, log: () => {},
    sendToBoard: (m) => { if (m.type === "verify_result") results.push(m); },
    runScript: async () => ({ exitCode: 0, timedOut: false, output: "ok\n" }),
    cleanup: async () => {},
  });
  runner.handle(job("j1"));
  runner.handle(job("j2"));
  await vi.waitFor(() => expect(results).toHaveLength(2), { timeout: 5000 });
  return results;
}

describe("verify jobs sharing one cached clone (#1779)", () => {
  it("fetches one after the other and both run", async () => {
    Object.assign(state, { activeFetches: 0, maxActiveFetches: 0, fetches: 0, failFirstFetch: false });
    const results = await runTwo();
    expect(state.maxActiveFetches).toBe(1);
    expect(results.every((r) => r.passed && !r.refused)).toBe(true);
  });

  it("retries a lost ref-lock race once instead of refusing", async () => {
    Object.assign(state, { activeFetches: 0, maxActiveFetches: 0, fetches: 0, failFirstFetch: true });
    const results = await runTwo();
    expect(results.some((r) => r.refused)).toBe(false);
    expect(results.every((r) => r.passed)).toBe(true);
  });
});
