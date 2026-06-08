import { describe, it, expect } from "vitest";
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";

describe("suggestBranchName", () => {
  it("generates feature/ak-N-slug for a numbered issue", () => {
    expect(suggestBranchName({ issueNumber: 42, title: "Fix the login bug" })).toBe(
      "feature/ak-42-fix-the-login-bug",
    );
  });

  it("generates feature/ak-slug without number when issueNumber is null", () => {
    expect(suggestBranchName({ issueNumber: null, title: "Add dark mode" })).toBe(
      "feature/ak-add-dark-mode",
    );
  });

  it("replaces non-alphanumeric characters with hyphens", () => {
    expect(suggestBranchName({ issueNumber: 1, title: "Fix: broken! UI@home" })).toBe(
      "feature/ak-1-fix-broken-ui-home",
    );
  });

  it("collapses multiple hyphens into one", () => {
    expect(suggestBranchName({ issueNumber: 1, title: "Fix   multiple   spaces" })).toBe(
      "feature/ak-1-fix-multiple-spaces",
    );
  });

  it("trims leading and trailing hyphens from slug", () => {
    expect(suggestBranchName({ issueNumber: 1, title: "!leading and trailing!" })).toBe(
      "feature/ak-1-leading-and-trailing",
    );
  });

  it("truncates long titles at 40 characters", () => {
    const longTitle = "a".repeat(60);
    const result = suggestBranchName({ issueNumber: 1, title: longTitle });
    const slug = result.replace("feature/ak-1-", "");
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it("lowercases the slug", () => {
    expect(suggestBranchName({ issueNumber: 5, title: "UPPERCASE TITLE" })).toBe(
      "feature/ak-5-uppercase-title",
    );
  });

  it("handles title with only special characters gracefully", () => {
    const result = suggestBranchName({ issueNumber: 1, title: "---" });
    expect(result).toMatch(/^feature\/ak-1/);
  });
});
