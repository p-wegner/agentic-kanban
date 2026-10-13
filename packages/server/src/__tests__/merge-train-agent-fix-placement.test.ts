/**
 * #1431 — the train fix agent hands its project and repo to the one-shot path, so a worker (not the
 * board host) can edit a checkout of the train tree; without that context it stays a host call.
 */
import { describe, expect, it, vi } from "vitest";
import { createOneShotAgentRunner } from "../services/merge-train-agent-fix.js";

describe("train fix agent placement context", () => {
  it("forwards project, repo and base branch to the one-shot call, with edits allowed", async () => {
    const invoke = vi.fn(async () => "");
    const runner = createOneShotAgentRunner({ invoke });
    await runner({ worktree: "/gate", prompt: "fix it", timeoutMs: 1234, turn: 1, projectId: "proj", repoPath: "/repo", baseBranch: "master" });
    expect(invoke).toHaveBeenCalledWith("fix it", expect.objectContaining({
      cwd: "/gate", timeout: 1234, allowEdits: true, projectId: "proj", repo: { repoPath: "/repo", baseBranch: "master" },
    }));
  });

  it("sends no placement context when the caller has none (a host-only call)", async () => {
    const invoke = vi.fn(async () => "");
    await createOneShotAgentRunner({ invoke })({ worktree: "/gate", prompt: "fix it", timeoutMs: 10, turn: 1 });
    const opts = (invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(opts).not.toHaveProperty("projectId");
    expect(opts).not.toHaveProperty("repo");
  });
});
