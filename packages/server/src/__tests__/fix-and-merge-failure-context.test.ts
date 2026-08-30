/**
 * #943 — fix-and-merge must be handed the gate's ACTUAL verify failure, not "Unknown merge error".
 *
 * Observed live: #935's merge was withheld by the pre-merge gate naming ONE red ratchet test.
 * Routing the workspace to `POST /api/workspaces/:id/fix-and-merge` (no body) produced an agent
 * whose prompt said "Unknown merge error" and whose body was entirely about working-tree
 * cleanliness. It checked `git status` (clean), confirmed the branch fast-forwards, made no
 * commits, and exited 0 with a confident report — a full ~10-minute cycle spent without ever
 * seeing the one test that was red. Expensive AND quiet: the workspace looked handled.
 *
 * These tests pin both halves of the fix: the failure is RECOVERED from the record when the
 * caller supplies none, and a gate failure gets a prompt that says "a test is red", not
 * "stash your changes".
 */
import { describe, it, expect, vi } from "vitest";
import {
  resolveFixAndMergeFailureContext,
  prepareFixAndMergeBriefing,
  extractVerifyLogPath,
  UNKNOWN_MERGE_ERROR,
} from "../services/fix-and-merge-context.js";
import { PRE_MERGE_GATE_FAILURE_REASON } from "../services/workspace-merge-gate.js";
import { buildFixAndMergePrompt } from "../services/merge-helpers.service.js";

/** The message shape `summarizeVerifyFailure` actually produces for the #935 failure. */
const GATE_MESSAGE =
  `FAIL src/__tests__/openapi-request-body-ratchet.test.ts (#838)\n` +
  `  no operation loses - or newly lacks - a request-body property list\n` +
  `  received: ["POST /api/projects/{id}/base-branch-health/reprobe"]\n` +
  `[full verify log: /tmp/kanban-verify-ws-935.log]`;

const noJob = () => null;
const noComment = async () => null;

function gateComment(payload: Record<string, unknown>) {
  return async () => ({ payload: JSON.stringify(payload) }) as never;
}

describe("extractVerifyLogPath", () => {
  it("pulls the path out of the trailer summarizeVerifyFailure appends", () => {
    expect(extractVerifyLogPath(GATE_MESSAGE)).toBe("/tmp/kanban-verify-ws-935.log");
  });

  it("is null when there is no trailer", () => {
    expect(extractVerifyLogPath("merge conflict in src/x.ts")).toBeNull();
    expect(extractVerifyLogPath(null)).toBeNull();
    expect(extractVerifyLogPath("")).toBeNull();
  });
});

describe("resolveFixAndMergeFailureContext", () => {
  it("prefers a caller-supplied error — the monitor path passes the live one", async () => {
    const ctx = await resolveFixAndMergeFailureContext({
      workspaceId: "ws-1",
      issueId: "iss-1",
      mergeError: "main checkout has uncommitted changes",
      readMergeJob: noJob as never,
      readLatestMergeAttempt: noComment as never,
    });
    expect(ctx.message).toBe("main checkout has uncommitted changes");
    expect(ctx.source).toBe("caller");
    expect(ctx.kind).toBe("merge");
  });

  it("recovers the gate failure from the in-memory merge job when the caller supplies none", async () => {
    const ctx = await resolveFixAndMergeFailureContext({
      workspaceId: "ws-935",
      issueId: "iss-935",
      readMergeJob: (() => ({
        error: `Pre-merge gate failed (verify) — merge withheld. ${GATE_MESSAGE}`,
        reason: PRE_MERGE_GATE_FAILURE_REASON,
      })) as never,
      readLatestMergeAttempt: noComment as never,
    });
    expect(ctx.source).toBe("merge-job");
    expect(ctx.kind).toBe("pre-merge-gate");
    // The one test that was actually red must be IN the message — that is the whole ticket.
    expect(ctx.message).toContain("openapi-request-body-ratchet.test.ts");
    expect(ctx.verifyLogPath).toBe("/tmp/kanban-verify-ws-935.log");
  });

  it("falls back to the durable gate-failure comment when no job survives (backend restart)", async () => {
    const ctx = await resolveFixAndMergeFailureContext({
      workspaceId: "ws-935",
      issueId: "iss-935",
      readMergeJob: noJob as never,
      readLatestMergeAttempt: gateComment({
        mergeReason: PRE_MERGE_GATE_FAILURE_REASON,
        gateStage: "verify",
        gateMessage: GATE_MESSAGE,
      }),
    });
    expect(ctx.source).toBe("gate-comment");
    expect(ctx.kind).toBe("pre-merge-gate");
    expect(ctx.message).toContain("openapi-request-body-ratchet.test.ts");
    expect(ctx.message).toContain("(verify)");
    expect(ctx.verifyLogPath).toBe("/tmp/kanban-verify-ws-935.log");
  });

  it("ignores a merge-attempt comment that is not a gate withhold", async () => {
    const ctx = await resolveFixAndMergeFailureContext({
      workspaceId: "ws-1",
      issueId: "iss-1",
      readMergeJob: noJob as never,
      readLatestMergeAttempt: gateComment({ sessionId: "s-1", targetBranch: "master" }),
    });
    expect(ctx.source).toBe("none");
    expect(ctx.message).toBe(UNKNOWN_MERGE_ERROR);
  });

  it("treats the placeholder echoed back by a client as 'the caller supplied nothing'", async () => {
    const ctx = await resolveFixAndMergeFailureContext({
      workspaceId: "ws-935",
      issueId: "iss-935",
      mergeError: UNKNOWN_MERGE_ERROR,
      readMergeJob: (() => ({ error: "merge conflict in src/x.ts" })) as never,
      readLatestMergeAttempt: noComment as never,
    });
    expect(ctx.source).toBe("merge-job");
    expect(ctx.message).toBe("merge conflict in src/x.ts");
  });

  it("still yields the placeholder when genuinely nothing is on record", async () => {
    const ctx = await resolveFixAndMergeFailureContext({
      workspaceId: "ws-1",
      issueId: null,
      readMergeJob: noJob as never,
      readLatestMergeAttempt: noComment as never,
    });
    expect(ctx).toMatchObject({ message: UNKNOWN_MERGE_ERROR, kind: "unknown", source: "none", verifyLogPath: null });
  });

  it("never throws when a lookup fails — a broken read must not refuse the fix", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = await resolveFixAndMergeFailureContext({
      workspaceId: "ws-1",
      issueId: "iss-1",
      readMergeJob: (() => { throw new Error("boom"); }) as never,
      readLatestMergeAttempt: (async () => { throw new Error("boom"); }) as never,
    });
    expect(ctx.message).toBe(UNKNOWN_MERGE_ERROR);
    warn.mockRestore();
  });
});

describe("buildFixAndMergePrompt — a red gate is not a dirty tree", () => {
  it("tells a gate-failure agent the tree is expected to be clean and a test is red", () => {
    const prompt = buildFixAndMergePrompt(GATE_MESSAGE, "master", "pre-merge-gate", "/tmp/kanban-verify-ws-935.log");
    expect(prompt).toContain("openapi-request-body-ratchet.test.ts");
    expect(prompt).toContain("/tmp/kanban-verify-ws-935.log");
    // The exact wrong conclusion the #935 agent reached, now pre-empted.
    expect(prompt).toMatch(/clean "git status" is EXPECTED/i);
    // The working-tree advice must NOT be what a gate failure is handed.
    expect(prompt).not.toMatch(/stash or commit them/i);
  });

  it("keeps the working-tree prompt for an ordinary merge failure", () => {
    const prompt = buildFixAndMergePrompt("main checkout has uncommitted changes", "master", "merge");
    expect(prompt).toMatch(/stash or commit them/i);
    expect(prompt).not.toMatch(/withheld by the pre-merge verify gate/i);
  });

  it("defaults to the working-tree prompt, so existing callers are unchanged", () => {
    expect(buildFixAndMergePrompt("boom", "master")).toMatch(/stash or commit them/i);
  });
});

/**
 * The briefing bundles recovery + prompt selection, because they are ONE decision: which failure
 * the agent is told about determines which prompt it must get. Splitting them at the call site is
 * what allowed a recovered gate failure to be paired with working-tree advice in the first place.
 */
describe("prepareFixAndMergeBriefing", () => {
  /** No DB read happens on the caller-supplied path, so an unused stub is honest here. */
  const noDb = {} as never;

  it("pairs a recovered GATE failure with the gate prompt, and appends the rebuild note", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { prompt, failure } = await prepareFixAndMergeBriefing(
      {
        workspaceId: "ws-935",
        issueId: "iss-935",
        mergeError: `Pre-merge gate failed (verify) — merge withheld. ${GATE_MESSAGE}`,
        baseBranch: "master",
        rebuildNote: "REBUILD-NOTE-SENTINEL",
      },
      noDb,
    );
    expect(failure.kind).toBe("pre-merge-gate");
    expect(prompt).toMatch(/withheld by the pre-merge verify gate/i);
    expect(prompt).toContain("openapi-request-body-ratchet.test.ts");
    expect(prompt).toContain("REBUILD-NOTE-SENTINEL");
    // The verify log must reach the agent, not just the returned context.
    expect(prompt).toContain("/tmp/kanban-verify-ws-935.log");
    log.mockRestore();
  });

  it("pairs an ordinary merge failure with the working-tree prompt", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { prompt, failure } = await prepareFixAndMergeBriefing(
      {
        workspaceId: "ws-1",
        issueId: "iss-1",
        mergeError: "main checkout has uncommitted changes",
        baseBranch: "master",
        rebuildNote: "note",
      },
      noDb,
    );
    expect(failure.kind).toBe("merge");
    expect(prompt).toMatch(/stash or commit them/i);
    log.mockRestore();
  });

  it("exposes the timeline fields the launcher records, so provenance survives to the timeline", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { timelineFields } = await prepareFixAndMergeBriefing(
      {
        workspaceId: "ws-935",
        issueId: "iss-935",
        mergeError: `Pre-merge gate failed (verify) — merge withheld. ${GATE_MESSAGE}`,
        baseBranch: "master",
        rebuildNote: "note",
      },
      noDb,
    );
    expect(timelineFields).toMatchObject({
      failureKind: "pre-merge-gate",
      failureSource: "caller",
      verifyLogPath: "/tmp/kanban-verify-ws-935.log",
    });
    // The recorded error is the RESOLVED failure, never the placeholder.
    expect(timelineFields.mergeError).toContain("openapi-request-body-ratchet.test.ts");
    log.mockRestore();
  });

  it("hands the prompt builder exactly the resolved kind and log path", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const buildPrompt = vi.fn(() => "PROMPT");
    const { prompt } = await prepareFixAndMergeBriefing(
      {
        workspaceId: "ws-935",
        issueId: "iss-935",
        mergeError: `Pre-merge gate failed (verify) — merge withheld. ${GATE_MESSAGE}`,
        baseBranch: "master",
        rebuildNote: "note",
        buildPrompt: buildPrompt as never,
      },
      noDb,
    );
    expect(prompt).toBe("PROMPT");
    expect(buildPrompt).toHaveBeenCalledWith(
      expect.stringContaining("openapi-request-body-ratchet.test.ts"),
      "master",
      "pre-merge-gate",
      "/tmp/kanban-verify-ws-935.log",
    );
    log.mockRestore();
  });
});
