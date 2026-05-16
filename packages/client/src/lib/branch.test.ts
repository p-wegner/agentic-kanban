import { describe, it, expect } from "vitest";
import { sanitizeBranchName, suggestBranchName } from "./branch";

describe("sanitizeBranchName", () => {
  it("lowercases input", () => {
    expect(sanitizeBranchName("MyBranch")).toBe("mybranch");
  });

  it("replaces spaces with hyphens", () => {
    expect(sanitizeBranchName("my branch name")).toBe("my-branch-name");
  });

  it("collapses multiple hyphens", () => {
    expect(sanitizeBranchName("my--branch")).toBe("my-branch");
  });

  it("removes leading and trailing hyphens", () => {
    expect(sanitizeBranchName("-my-branch-")).toBe("my-branch");
  });

  it("allows slashes", () => {
    expect(sanitizeBranchName("feature/my-branch")).toBe("feature/my-branch");
  });

  it("truncates to 80 chars", () => {
    const long = "a".repeat(100);
    expect(sanitizeBranchName(long)).toHaveLength(80);
  });
});

describe("suggestBranchName", () => {
  it("uses feature/ prefix", () => {
    const result = suggestBranchName({ issueNumber: 1, title: "fix bug" });
    expect(result.startsWith("feature/")).toBe(true);
  });

  it("includes ak- prefix after feature/", () => {
    const result = suggestBranchName({ issueNumber: 1, title: "fix bug" });
    expect(result).toBe("feature/ak-1-fix-bug");
  });

  it("includes issue number when present", () => {
    const result = suggestBranchName({ issueNumber: 42, title: "add feature" });
    expect(result).toBe("feature/ak-42-add-feature");
  });

  it("omits issue number when null", () => {
    const result = suggestBranchName({ issueNumber: null, title: "add feature" });
    expect(result).toBe("feature/ak-add-feature");
  });

  it("omits issue number when undefined", () => {
    const result = suggestBranchName({ title: "add feature" });
    expect(result).toBe("feature/ak-add-feature");
  });

  it("sanitizes special characters in title", () => {
    const result = suggestBranchName({ issueNumber: 3, title: "Fix: the (big) bug!" });
    expect(result).toBe("feature/ak-3-fix-the-big-bug");
  });

  it("truncates long titles to 40 chars in slug", () => {
    const longTitle = "a".repeat(60);
    const result = suggestBranchName({ issueNumber: 1, title: longTitle });
    const slug = result.replace("feature/ak-1-", "");
    expect(slug.length).toBeLessThanOrEqual(40);
  });
});
