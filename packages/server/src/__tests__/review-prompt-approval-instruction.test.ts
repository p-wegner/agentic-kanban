import { describe, it, expect } from "vitest";
import { buildReviewPrompt } from "../services/review.service.js";
import { createTestDb } from "./helpers/test-db.js";

// Regression: when buildReviewPrompt was called WITHOUT a workspaceId, the
// {{workspaceId}} placeholder collapsed to an empty string, leaving the agent with
// the un-actionable instruction "Use the mark_ready_for_merge MCP tool with
// workspaceId=" — so a review agent could not signal approval and exited "stopped".
// The approval branch must always be actionable: a real id when present, an
// issue-status fallback when absent — and must never emit a dangling "workspaceId=".
describe("buildReviewPrompt approval instruction", () => {
  it("uses the literal workspace id in the approval branch when one is given", async () => {
    const { db } = createTestDb();
    const { prompt } = await buildReviewPrompt(
      db, "feature/x", "master", "issue-1", true, undefined, undefined, undefined, "ws-123",
    );
    expect(prompt).toContain("mark_ready_for_merge");
    expect(prompt).toContain("workspaceId=ws-123");
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
});
