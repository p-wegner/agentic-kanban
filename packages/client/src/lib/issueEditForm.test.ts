import { describe, expect, it } from "vitest";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import {
  buildIssueUpdatePayload,
  EXTERNAL_URL_ERROR,
  hasIssueEditChanges,
  issueEditBaseline,
  validateIssueEditFields,
  type IssueEditFields,
} from "./issueEditForm.js";
import { issueFixture } from "../__tests__/fixtures/issue.js";

/**
 * `packages/client` has no jsdom by design, so a hook is not drivable here (#782). These are
 * the parts of `useIssueEditForm` that never needed one: a nine-field dirty comparison and the
 * save-payload construction. Every case below was mutation-checked — the mutation is named in
 * the comment, and the test was confirmed to go red with it applied.
 */

const issue = (overrides: Partial<IssueWithStatus> = {}) => issueFixture(overrides);

function fields(overrides: Partial<IssueEditFields> = {}): IssueEditFields {
  return { ...issueEditBaseline(issue()), ...overrides };
}

describe("issueEditBaseline", () => {
  it("projects the saved issue onto the editable fields, nulls becoming empty strings", () => {
    expect(issueEditBaseline(issue({
      title: "Fix the gate",
      description: null,
      issueType: undefined,
      estimate: null,
      dueDate: null,
      externalKey: null,
      externalUrl: null,
      skipAutoReview: undefined,
      milestoneId: null,
    }))).toEqual({
      title: "Fix the gate",
      description: "",
      issueType: "task",
      estimate: "",
      dueDate: "",
      externalKey: "",
      externalUrl: "",
      skipAutoReview: false,
      milestoneId: null,
    });
  });

  it("keeps milestoneId nullable rather than collapsing it to a string", () => {
    // Mutation: `milestoneId: issue.milestoneId ?? ""` — the payload's `|| null` would still
    // send null, but the dirty check would then compare "" against null and read as changed.
    expect(issueEditBaseline(issue({ milestoneId: null })).milestoneId).toBeNull();
    expect(issueEditBaseline(issue({ milestoneId: "m1" })).milestoneId).toBe("m1");
  });

  it("passes the saved values through unchanged when they are all set", () => {
    const saved = issue({
      title: "t", description: "d", issueType: "bug", estimate: "M",
      dueDate: "2026-09-01", externalKey: "JIRA-1", externalUrl: "https://x.test/1",
      skipAutoReview: true, milestoneId: "m1",
    });
    expect(issueEditBaseline(saved)).toEqual({
      title: "t", description: "d", issueType: "bug", estimate: "M",
      dueDate: "2026-09-01", externalKey: "JIRA-1", externalUrl: "https://x.test/1",
      skipAutoReview: true, milestoneId: "m1",
    });
  });
});

describe("hasIssueEditChanges", () => {
  it("is false when every field still matches the saved issue", () => {
    const saved = issue({ description: "d", estimate: "M", skipAutoReview: true, milestoneId: "m1" });
    expect(hasIssueEditChanges(issueEditBaseline(saved), saved)).toBe(false);
  });

  it("is false when the saved issue's nullable columns are null and the fields are empty", () => {
    // Mutation: drop a `?? ""` from the baseline — an untouched form on an issue with a null
    // description would then read as dirty and prompt "discard changes?" on every cancel.
    const saved = issue({ description: null, estimate: null, dueDate: null, externalKey: null, externalUrl: null });
    expect(hasIssueEditChanges(issueEditBaseline(saved), saved)).toBe(false);
  });

  // Each of the nine comparisons, so deleting any one line of the comparison goes red.
  const dirtied: [string, Partial<IssueEditFields>][] = [
    ["title", { title: "changed" }],
    ["description", { description: "changed" }],
    ["issueType", { issueType: "bug" }],
    ["estimate", { estimate: "L" }],
    ["dueDate", { dueDate: "2026-09-09" }],
    ["externalKey", { externalKey: "JIRA-9" }],
    ["externalUrl", { externalUrl: "https://x.test/9" }],
    ["skipAutoReview", { skipAutoReview: true }],
    ["milestoneId", { milestoneId: "m9" }],
  ];
  for (const [name, patch] of dirtied) {
    it("detects a change to " + name, () => {
      expect(hasIssueEditChanges(fields(patch), issue())).toBe(true);
    });
  }

  it("treats whitespace-only edits as changes, since the save trims them away", () => {
    // Mutation: compare `fields.title.trim() !== baseline.title` — the confirm would then be
    // skipped for an edit the save WOULD send (a trimmed title differing only in whitespace
    // is discarded silently, which is exactly what the confirm exists to prevent).
    expect(hasIssueEditChanges(fields({ title: "  " + issue().title + "  " }), issue())).toBe(true);
  });
});

describe("validateIssueEditFields", () => {
  it("accepts an empty external URL — clearing the link is legal", () => {
    expect(validateIssueEditFields(fields({ externalUrl: "" }))).toBeNull();
    expect(validateIssueEditFields(fields({ externalUrl: "   " }))).toBeNull();
  });

  it("accepts http and https", () => {
    expect(validateIssueEditFields(fields({ externalUrl: "http://x.test/1" }))).toBeNull();
    expect(validateIssueEditFields(fields({ externalUrl: " https://x.test/1 " }))).toBeNull();
  });

  it("rejects a non-http scheme and a bare host", () => {
    // Mutation: drop the guard (`return null` unconditionally) — all three go green, and the
    // panel would PATCH a javascript:/file: URL straight into a rendered external link.
    expect(validateIssueEditFields(fields({ externalUrl: "javascript:alert(1)" }))).toBe(EXTERNAL_URL_ERROR);
    expect(validateIssueEditFields(fields({ externalUrl: "ftp://x.test/1" }))).toBe(EXTERNAL_URL_ERROR);
    expect(validateIssueEditFields(fields({ externalUrl: "x.test/1" }))).toBe(EXTERNAL_URL_ERROR);
  });
});

describe("buildIssueUpdatePayload", () => {
  it("trims the title and the external key", () => {
    // Mutation: drop `.trim()` on title — the payload keeps the padding and the board shows it.
    const payload = buildIssueUpdatePayload(fields({ title: "  Fix the gate  ", externalKey: "  JIRA-1  " }), []);
    expect(payload.title).toBe("Fix the gate");
    expect(payload.externalKey).toBe("JIRA-1");
  });

  it("normalises emptied fields to null so the server clears the column", () => {
    // Mutation: `estimate: fields.estimate || undefined` — undefined LEAVES the column alone,
    // so clearing an estimate/due date/link in the UI would silently not stick.
    const payload = buildIssueUpdatePayload(fields({
      estimate: "", dueDate: "", externalKey: "  ", externalUrl: "", milestoneId: null,
    }), []);
    expect(payload.estimate).toBeNull();
    expect(payload.dueDate).toBeNull();
    expect(payload.externalKey).toBeNull();
    expect(payload.externalUrl).toBeNull();
    expect(payload.milestoneId).toBeNull();
  });

  it("leaves an emptied description undefined, not null or empty", () => {
    // Mutation: `description: fullDescription` — an image-only or emptied edit would then
    // blank the description column instead of leaving it untouched.
    expect(buildIssueUpdatePayload(fields({ description: "   " }), []).description).toBeUndefined();
  });

  it("appends pasted images as numbered screenshot markdown after the description", () => {
    // Mutation: index from 0 (`screenshot-${i}`) or join the images with a blank line — the
    // caption numbering and the single newline between images are both pinned here.
    const payload = buildIssueUpdatePayload(fields({ description: "  before  " }), ["data:a", "data:b"]);
    expect(payload.description).toBe("before\n\n![screenshot-1](data:a)\n![screenshot-2](data:b)");
  });

  it("sends only the image markdown when the description is empty", () => {
    expect(buildIssueUpdatePayload(fields({ description: "" }), ["data:a"]).description)
      .toBe("![screenshot-1](data:a)");
  });

  it("trims the external URL it sends", () => {
    expect(buildIssueUpdatePayload(fields({ externalUrl: "  https://x.test/1  " }), []).externalUrl)
      .toBe("https://x.test/1");
  });

  it("passes skipAutoReview through as a boolean, including false", () => {
    // Mutation: `skipAutoReview: fields.skipAutoReview || undefined` — unchecking the box
    // would never reach the server.
    expect(buildIssueUpdatePayload(fields({ skipAutoReview: false }), []).skipAutoReview).toBe(false);
    expect(buildIssueUpdatePayload(fields({ skipAutoReview: true }), []).skipAutoReview).toBe(true);
  });
});
