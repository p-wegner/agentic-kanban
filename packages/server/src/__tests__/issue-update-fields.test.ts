import { describe, it, expect } from "vitest";
import { buildSharedIssueUpdate } from "../services/issue.service.js";

const NOW = "2026-06-18T12:00:00.000Z";

describe("buildSharedIssueUpdate", () => {
  it("sets only updatedAt for an empty body", () => {
    expect(buildSharedIssueUpdate({}, NOW)).toEqual({ updatedAt: NOW });
  });

  it("includes only fields present in the body (undefined is skipped)", () => {
    expect(buildSharedIssueUpdate({ title: "T", priority: "high" }, NOW)).toEqual({
      updatedAt: NOW,
      title: "T",
      priority: "high",
    });
  });

  it("couples statusId with statusChangedAt = now", () => {
    const out = buildSharedIssueUpdate({ statusId: "s1" }, NOW);
    expect(out.statusId).toBe("s1");
    expect(out.statusChangedAt).toBe(NOW);
  });

  it("does not set statusChangedAt when statusId is absent", () => {
    expect(buildSharedIssueUpdate({ title: "T" }, NOW)).not.toHaveProperty("statusChangedAt");
  });

  it("passes through the shared editable columns", () => {
    const body = {
      title: "T",
      description: "D",
      priority: "high",
      issueType: "feature",
      sortOrder: 5,
      estimate: "2h",
      skipAutoReview: true,
      dueDate: "2026-07-01",
      workflowTemplateId: "wf1",
    };
    const out = buildSharedIssueUpdate(body, NOW);
    expect(out).toMatchObject(body);
    expect(out.updatedAt).toBe(NOW);
  });

  it("excludes caller-specific fields — checklist/pinned/milestoneId stay with updateIssue, not bulk", () => {
    const out = buildSharedIssueUpdate({ pinned: true, milestoneId: "m1", checklist: [] }, NOW);
    expect(out).toEqual({ updatedAt: NOW });
  });
});
