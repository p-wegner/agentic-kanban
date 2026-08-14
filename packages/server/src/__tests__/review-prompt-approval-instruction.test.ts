import { describe, it, expect } from "vitest";
import { buildReviewPrompt } from "../services/review.service.js";
import { createTestDb } from "./helpers/test-db.js";

// The approval branch must always be actionable — originally because a missing workspaceId
// collapsed {{workspaceId}} to "" and left the un-actionable "mark_ready_for_merge with
// workspaceId=", so the reviewer could not signal approval and exited "stopped".
//
// #466 changed WHAT is actionable for a workspace review: the reviewer no longer signals
// approval at all. `handleReviewSessionExit` sets `readyForMerge` itself, and only after its
// own pre-merge gate passes — so the tool call was redundant (the board re-decides regardless)
// and actively misleading when the tool was unreachable: a CLEAN review ended with "Blocked:
// mark_ready_for_merge is not available", which reads as "the review could not approve this"
// and sends the reader hunting an MCP fault instead of the failing gate that actually withheld it.
describe("buildReviewPrompt approval instruction", () => {
  it("tells a workspace reviewer to report and exit, NOT to flip the flag itself (#466)", async () => {
    const { db } = createTestDb();
    const { prompt } = await buildReviewPrompt(
      db, "feature/x", "master", "issue-1", true, undefined, undefined, undefined, "ws-123",
    );
    // The flag's owner is the exit workflow, so the reviewer must not be sent after a tool.
    expect(prompt).not.toContain("mark_ready_for_merge");
    expect(prompt).not.toContain("workspaceId=ws-123");
    expect(prompt).toContain("no CRITICAL or MAJOR issues");
    expect(prompt).toContain("pre-merge gate");
    // the unsubstituted placeholder must never survive into the prompt
    expect(prompt).not.toContain("{{workspaceId}}");
  });

  it("falls back to the issue-status path when no workspace id is available", async () => {
    const { db } = createTestDb();
    const { prompt } = await buildReviewPrompt(
      db, "feature/x", "master", "issue-1", true, undefined, undefined, undefined, undefined,
    );
    // no dangling empty argument, and a concrete actionable instruction instead
    expect(prompt).not.toContain("workspaceId=\n");
    expect(prompt).not.toContain("workspaceId= ");
    expect(prompt).toContain("move issue issue-1 to 'AI Reviewed'");
    expect(prompt).not.toContain("{{workspaceId}}");
  });

  // #822: verifyAgent=reviewer reviews used to instruct the agent to MERGE the workspace
  // itself (curl POST /merge), which closed the workspace inside the review session. The
  // exit-workflow then early-returned on `closed && mergedAt`, so the verify_script + smoke
  // gate (the reviewSessionIds handler) never ran — turning ON visual verification
  // paradoxically DISABLED the automatic verify+smoke gate. The reviewer must verify the UI
  // and then leave the gate to run on exit, NOT self-merge. (#466: "signal approval" is now
  // "report the verdict" — the flag itself belongs to the exit workflow either way, which is
  // exactly why self-merging was wrong.)
  it("reviewer mode verifies + approves but does NOT self-merge (so the exit gate runs) (#822)", async () => {
    const { db } = createTestDb();
    const { prompt } = await buildReviewPrompt(
      db, "feature/x", "master", "issue-1", true, undefined, undefined, undefined, "ws-123",
      "code-review", "reviewer",
    );
    // still does the visual verification
    expect(prompt).toContain("Visual Verification");
    expect(prompt).toContain("playwright-cli");
    expect(prompt).toContain("WebM proof recording");
    expect(prompt).toContain('type: "video"');
    expect(prompt).toContain('mimeType: "video/webm"');
    expect(prompt).toContain('workspaceId: "ws-123"');
    // leaves approval to the gated exit path, NOT a hand-rolled merge
    expect(prompt).toContain("pre-merge gate");
    expect(prompt).not.toMatch(/curl[^\n]*\/merge/);
    expect(prompt).not.toContain("/api/workspaces/ws-123/merge");
  });

  it("non-reviewer mode appends no visual-verification block", async () => {
    const { db } = createTestDb();
    const { prompt } = await buildReviewPrompt(
      db, "feature/x", "master", "issue-1", true, undefined, undefined, undefined, "ws-123",
      "code-review", "none",
    );
    expect(prompt).not.toContain("Visual Verification");
    expect(prompt).not.toMatch(/curl[^\n]*\/merge/);
  });
});
