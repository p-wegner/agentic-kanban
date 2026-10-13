// #1455 — the board re-places a refused (profile-unknown) assign under the SAME sessionId. The
// worker had already provisioned `kanban/<sessionId>` for the refused attempt and never removed it,
// so the re-placed assign's `git worktree add -b kanban/<sessionId>` failed on the leftover branch.
// A refusal before the agent starts must tear the provisioned checkout (and its branch) down.

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerAgentRunner } from "../worker/worker-agent-runner.js";
import type { WorkerLaunchSpec, WorkerRepoTransport, WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";

const repo: WorkerRepoTransport = {
  projectId: "p1",
  gitPort: 1,
  gitToken: "t",
  branch: "feature/ak-1455",
  baseBranch: "master",
  incomingRef: "refs/kanban/incoming/feature/ak-1455",
};

const spec = (): WorkerLaunchSpec => ({
  command: process.execPath,
  args: ["-e", "process.exit(0)"],
  env: {},
  cwd: tmpdir(),
  stdinPrompt: "",
  hangTimeoutMs: 0,
  intent: { provider: "claude", profile: "ghost" },
} as unknown as WorkerLaunchSpec);

describe("#1455 — a refused assign leaves no checkout behind", () => {
  it("cleans up the provisioned checkout when the profile is unknown, and a re-place provisions again", async () => {
    const messages: WorkerToBoardMessage[] = [];
    const checkout = mkdtempSync(join(tmpdir(), "ak-worker-checkout-1455-"));
    const provision = vi.fn(async () => ({ cwd: checkout, cacheDir: tmpdir() }));
    const cleanup = vi.fn(async () => {});
    const runner = createWorkerAgentRunner((m) => { messages.push(m); }, {
      boardUrl: "http://board",
      repoOps: { provision, push: async () => {}, cleanup },
      workRoot: mkdtempSync(join(tmpdir(), "ak-worker-root-")),
      profileHome: mkdtempSync(join(tmpdir(), "ak-worker-home-")),
    });

    runner.assignWithRepo("s-1455", spec(), repo);
    await vi.waitFor(() => expect(messages.some((m) => m.type === "assign_failed")).toBe(true));
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));

    // The board re-places the same sessionId on this worker: it is provisioned afresh, not refused as running.
    runner.assignWithRepo("s-1455", spec(), repo);
    await vi.waitFor(() => expect(provision).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2));
    const failures = messages.filter((m) => m.type === "assign_failed") as Array<{ error: string }>;
    expect(failures.length).toBe(2);
    expect(failures.every((f) => /unknown agent profile/i.test(f.error))).toBe(true);
  });
});
