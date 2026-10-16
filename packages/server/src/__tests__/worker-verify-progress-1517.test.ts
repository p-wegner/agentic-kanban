import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonVerifyRunner, createVerifyProgressTracker, parseVerifyProgress } from "../worker/worker-verify-runner.js";
import { renderStatus } from "../worker/worker-lifecycle.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe("#1517 verify progress", () => {
  it("counts colourised marker lines (FORCE_COLOR workers)", () => {
    expect(parseVerifyProgress("\u001b[32m\u2713\u001b[39m src/a.test.ts (3 tests) 5ms\n \u001b[31mFAIL\u001b[39m src/b.test.ts\n").filesDone).toBe(2);
  });

  it("counts cumulatively across chunks and across several vitest runs, with no sliding-window loss", () => {
    const t = createVerifyProgressTracker();
    t.push("\u2713 src/a.te");
    t.push("st.ts (1 test)\n\u2713 src/b.test.ts\n");
    t.push(`${"x".repeat(200_000)}\n`);
    expect(t.snapshot()).toEqual({ filesDone: 2 });
    t.push(" Test Files  2 passed (2)\n\u2713 pkg2/c.test.ts\n");
    expect(t.snapshot()).toEqual({ filesDone: 3, filesTotal: 2 });
    t.push(" Test Files  1 passed (1)\n");
    expect(t.snapshot()).toEqual({ filesDone: 3, filesTotal: 3 });
  });

  it("jobs() exposes stage and file counts of a running job, and renderStatus prints them", async () => {
    const root = mkdtempSync(join(tmpdir(), "ak-verify-1517-")); roots.push(root);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const runner = createDaemonVerifyRunner({
      workRoot: root, boardUrl: () => "http://x", sendToBoard: () => undefined, log: () => undefined, slots: 1, ramGb: 8,
      prepareCheckout: async () => ({ ok: true, dir: join(root, "verify", "j1"), sha: "a".repeat(40) }),
      runScript: async (_d, _s, o) => { o.onOutput("\u2713 a.test.ts\n\u2713 b.test.ts\n"); await gate; return { exitCode: 0, timedOut: false, output: "ok" }; },
      cleanup: async () => undefined,
    });
    const job = {
      type: "verify_job" as const, jobId: "j1abcdefgh", sha: "a".repeat(40), tier: "impact", script: "x", timeoutMs: 60_000,
      auth: { projectId: "p", gitPort: 1, gitToken: "t", branch: "b", incomingRef: "r" },
    };
    runner.handle(job);
    await new Promise((r) => setTimeout(r, 30));
    const jobs = runner.jobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ jobId: "j1abcdefgh", tier: "impact", stage: "verify", filesDone: 2 });
    expect(renderStatus({ verify: { jobs } })).toMatch(/verify job:\s+j1abcdef impact @ aaaaaaaaa verify 2 files/);
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(runner.jobs()).toEqual([]);
  });
});
