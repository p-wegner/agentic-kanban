import { describe, it, expect } from "vitest";
import {
  ISSUE_TYPES,
  ISSUE_ESTIMATES,
  ISSUE_ARTIFACT_TYPES,
  ISSUE_TYPE_ALIASES_REJECTED,
  isIssueType,
  isIssueEstimate,
  issueTypeLabel,
} from "../src/lib/issue-vocab.js";

/**
 * The issue domain's closed vocabularies (#570) — pinning both the runtime arrays
 * themselves (regression: `chore` was silently missing from four client selects) and
 * the derived guards/labels.
 */
describe("issue-vocab", () => {
  describe("ISSUE_TYPES", () => {
    it("includes all four canonical types, including chore", () => {
      expect(ISSUE_TYPES).toEqual(["task", "bug", "feature", "chore"]);
    });

    it("does not include epic — that is a tag, not a type", () => {
      expect(ISSUE_TYPES as readonly string[]).not.toContain("epic");
    });
  });

  describe("ISSUE_ESTIMATES", () => {
    it("lists the five t-shirt sizes in order", () => {
      expect(ISSUE_ESTIMATES).toEqual(["XS", "S", "M", "L", "XL"]);
    });
  });

  describe("ISSUE_ARTIFACT_TYPES", () => {
    it("includes video even though it is not offered everywhere", () => {
      expect(ISSUE_ARTIFACT_TYPES).toEqual(["image", "text", "link", "video"]);
    });
  });

  describe("ISSUE_TYPE_ALIASES_REJECTED", () => {
    it("names epic as the rejected alias", () => {
      expect(ISSUE_TYPE_ALIASES_REJECTED).toEqual(["epic"]);
    });
  });

  describe("isIssueType", () => {
    it("accepts every canonical type", () => {
      for (const t of ISSUE_TYPES) expect(isIssueType(t)).toBe(true);
    });

    it("rejects epic — the type/tag confusion #570 resolves", () => {
      expect(isIssueType("epic")).toBe(false);
    });

    it("rejects unknown strings and non-string values", () => {
      expect(isIssueType("nonsense")).toBe(false);
      expect(isIssueType(undefined)).toBe(false);
      expect(isIssueType(null)).toBe(false);
      expect(isIssueType(42)).toBe(false);
      expect(isIssueType({})).toBe(false);
    });
  });

  describe("isIssueEstimate", () => {
    it("accepts every canonical estimate", () => {
      for (const e of ISSUE_ESTIMATES) expect(isIssueEstimate(e)).toBe(true);
    });

    it("rejects unknown strings and non-string values", () => {
      expect(isIssueEstimate("XXL")).toBe(false);
      expect(isIssueEstimate("")).toBe(false);
      expect(isIssueEstimate(undefined)).toBe(false);
      expect(isIssueEstimate(3)).toBe(false);
    });

    it("is case-sensitive — lowercase is not a canonical estimate", () => {
      expect(isIssueEstimate("xs")).toBe(false);
    });
  });

  describe("issueTypeLabel", () => {
    it("capitalizes the first letter of every canonical type", () => {
      expect(issueTypeLabel("task")).toBe("Task");
      expect(issueTypeLabel("bug")).toBe("Bug");
      expect(issueTypeLabel("feature")).toBe("Feature");
      expect(issueTypeLabel("chore")).toBe("Chore");
    });
  });
});
