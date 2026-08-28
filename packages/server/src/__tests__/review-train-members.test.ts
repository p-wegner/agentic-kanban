import { describe, it, expect } from "vitest";
import { buildMembersBlock, buildReviewPrompt } from "../services/review.service.js";
import { createTestDb } from "./helpers/test-db.js";

// Merge train review (#907): {{members}} in the code-review skill renders every train
// member's number/title/acceptance-criteria so one reviewer session can judge the whole
// assembled diff against every ticket it closes.
describe("buildMembersBlock", () => {
  it("renders nothing for a non-train (empty member list)", () => {
    expect(buildMembersBlock([])).toBe("");
  });

  it("renders number, title and description for every member", () => {
    const block = buildMembersBlock([
      { issueNumber: 101, title: "Add X", description: "Acceptance: X works" },
      { issueNumber: 102, title: "Add Y", description: "Acceptance: Y works" },
      { issueNumber: 103, title: "Add Z", description: "Acceptance: Z works" },
    ]);
    expect(block).toContain("#101 — Add X");
    expect(block).toContain("Acceptance: X works");
    expect(block).toContain("#102 — Add Y");
    expect(block).toContain("Acceptance: Y works");
    expect(block).toContain("#103 — Add Z");
    expect(block).toContain("Acceptance: Z works");
  });

  it("falls back to a placeholder for a member with no description", () => {
    const block = buildMembersBlock([{ issueNumber: 5, title: "No desc", description: null }]);
    expect(block).toContain("(no description)");
  });
});

describe("buildReviewPrompt {{members}}", () => {
  it("substitutes an empty string when no membersBlock is passed (single-ticket review)", async () => {
    const { db } = createTestDb();
    const { prompt } = await buildReviewPrompt(
      db, "feature/x", "master", "issue-1", true, undefined, undefined, undefined, "ws-123",
    );
    expect(prompt).not.toContain("{{members}}");
  });

  it("substitutes the rendered members block when supplied (train review)", async () => {
    const { db } = createTestDb();
    const membersBlock = buildMembersBlock([
      { issueNumber: 1, title: "First", description: "Criteria A" },
      { issueNumber: 2, title: "Second", description: "Criteria B" },
    ]);
    const { prompt } = await buildReviewPrompt(
      db, "feature/train", "master", "issue-lead", true, undefined, undefined, undefined, "ws-train",
      "code-review", undefined, null, membersBlock,
    );
    expect(prompt).toContain("#1 — First");
    expect(prompt).toContain("Criteria A");
    expect(prompt).toContain("#2 — Second");
    expect(prompt).toContain("Criteria B");
    expect(prompt).not.toContain("{{members}}");
  });
});
