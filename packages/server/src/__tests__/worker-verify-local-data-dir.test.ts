import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseBoardToWorkerMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import { createDaemonVerifyRunner } from "../worker/worker-verify-runner.js";

const SHA = "c".repeat(40);
const BOARD_DIR = "Z:\board-host-only\kanban-verify-gate-abc";

// Trains 2026-10-14-40/41: the board's gate sends AGENTIC_KANBAN_DIR pointing at a temp dir on
// the BOARD's disk; on a worker that path does not exist and 219 DB-backed suites died with
// ENOENT mkdir. The worker keeps the isolation but on a dir it owns, and removes it afterwards.
describe("worker verify runner: AGENTIC_KANBAN_DIR is rebased onto the worker", () => {
  it("replaces the board's data dir with a local temp dir for install and verify, then removes it", async () => {
    const seen: string[] = [];
    let finished!: () => void;
    const done = new Promise<void>((r) => { finished = r; });
    const worker = createDaemonVerifyRunner({
      workRoot: "/tmp/none", boardUrl: () => "http://board:1", slots: 1, ramGb: 32, log: () => {},
      sendToBoard: (m) => { if ((m as { stage?: string }).stage === "done") finished(); },
      prepareCheckout: async () => ({ ok: true, dir: "/tmp/co", sha: SHA }),
      runScript: async (_d, _s, opts) => {
        seen.push(opts.env.AGENTIC_KANBAN_DIR);
        expect(existsSync(opts.env.AGENTIC_KANBAN_DIR)).toBe(true);
        return { exitCode: 0, timedOut: false, output: "" };
      },
      cleanup: async () => {},
    });
    const frame = parseBoardToWorkerMessage(JSON.stringify({
      type: "verify_job", jobId: "j1", sha: SHA, tier: "full", kind: "train-gate",
      script: "pnpm test:mine", setupScript: "pnpm install", timeoutMs: 60_000,
      env: { AGENTIC_KANBAN_DIR: BOARD_DIR },
      auth: { projectId: "p1", gitPort: 9, gitToken: "tok", branch: "train/x", incomingRef: "refs/incoming/x" },
    }))!;
    expect(worker.handle(frame)).toBe(true);
    await done;
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).not.toBe(BOARD_DIR);
    expect(seen[0].startsWith(tmpdir())).toBe(true);
    expect(existsSync(seen[0])).toBe(false);
  });
});
