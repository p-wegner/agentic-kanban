/**
 * #628 — the merge gate is where the deferred installs get their safety back.
 *
 * `setupFailedBlocking` (#169) refused the LAUNCH when a blocking setup script failed, so an
 * agent never worked in a worktree with missing dependencies. Deferring installs to the
 * background gives that guarantee up on purpose — the agent starts in seconds instead of
 * 30-60 minutes — so something else has to refuse to LAND a branch that was built without its
 * dependencies. That is `describeOutstandingRepoInstalls`, called first in `runPreMergeGate`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const listStatesMock = vi.fn();

vi.mock("../repositories/repo.repository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repositories/repo.repository.js")>()),
  listWorkspaceRepoInstallStates: (...args: unknown[]) => listStatesMock(...args),
}));

const { describeOutstandingRepoInstalls } = await import("../services/pre-merge-gate-installs.js");

const db = {} as never;

const row = (name: string, installState: string | null, installDetail: string | null = null) => ({
  name, path: `C:/repos/${name}`, installState, installDetail,
});

beforeEach(() => vi.clearAllMocks());

describe("describeOutstandingRepoInstalls (#628)", () => {
  it("is a no-op for an inline-install project (every state NULL)", async () => {
    listStatesMock.mockResolvedValue([row("a", null), row("b", null)]);
    expect(await describeOutstandingRepoInstalls("w1", db)).toBeNull();
  });

  it("is a no-op once every deferred install finished", async () => {
    listStatesMock.mockResolvedValue([row("a", "done"), row("b", "skipped"), row("c", null)]);
    expect(await describeOutstandingRepoInstalls("w1", db)).toBeNull();
  });

  it("blocks while an install is still pending or running, and names the repos", async () => {
    listStatesMock.mockResolvedValue([row("a", "done"), row("b", "running"), row("c", "pending")]);
    const msg = await describeOutstandingRepoInstalls("w1", db);
    expect(msg).toContain("2 repo(s)");
    expect(msg).toContain("b");
    expect(msg).toContain("c");
  });

  it("blocks on a FAILED install and leads with the failure, not the count of outstanding ones", async () => {
    listStatesMock.mockResolvedValue([
      row("a", "failed", "exit 1: could not resolve org.example:thing"),
      row("b", "pending"),
    ]);
    const msg = await describeOutstandingRepoInstalls("w1", db);
    expect(msg).toContain("FAILED");
    expect(msg).toContain("could not resolve org.example:thing");
    // A failed install is not something waiting will fix, so the message must not read as
    // "still running" — that is what would send an operator back to wait it out.
    expect(msg).not.toContain("still running");
  });

  it("says so even with no detail recorded, rather than printing an empty reason", async () => {
    listStatesMock.mockResolvedValue([row("a", "failed", null)]);
    expect(await describeOutstandingRepoInstalls("w1", db)).toContain("no detail recorded");
  });

  it("degrades to today's behaviour when the rows cannot be read — an unreadable row must not block every merge in the project", async () => {
    listStatesMock.mockRejectedValue(new Error("db gone"));
    expect(await describeOutstandingRepoInstalls("w1", db)).toBeNull();
  });
});
