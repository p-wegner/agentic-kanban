import { describe, it, expect } from "vitest";
import {
  REPO_TAG_PREFIX,
  repoTagName,
  isRepoTagName,
  repoNameFromTag,
  resolveRepoName,
  assignChildRepos,
} from "../src/lib/repo-tags.js";

describe("repo tag naming", () => {
  it("builds a repo:<name> tag and trims whitespace", () => {
    expect(repoTagName("web")).toBe("repo:web");
    expect(repoTagName("  api ")).toBe("repo:api");
    expect(REPO_TAG_PREFIX).toBe("repo:");
  });

  it("recognises repo tags and extracts the name", () => {
    expect(isRepoTagName("repo:web")).toBe(true);
    expect(isRepoTagName("repo:")).toBe(false); // empty name
    expect(isRepoTagName("epic")).toBe(false);
    expect(repoNameFromTag("repo:web")).toBe("web");
    expect(repoNameFromTag("needs-visual-verification")).toBeNull();
  });
});

describe("resolveRepoName", () => {
  const repos = ["web", "api", "shared-lib"];

  it("matches case-insensitively on the full name", () => {
    expect(resolveRepoName("API", repos)).toBe("api");
    expect(resolveRepoName("Web", repos)).toBe("web");
  });

  it("falls back to the last path segment (path / owner-repo answers)", () => {
    expect(resolveRepoName("apps/web", repos)).toBe("web");
    expect(resolveRepoName("me/shared-lib", repos)).toBe("shared-lib");
  });

  it("returns null for unknown or empty suggestions", () => {
    expect(resolveRepoName("mobile", repos)).toBeNull();
    expect(resolveRepoName("", repos)).toBeNull();
    expect(resolveRepoName(null, repos)).toBeNull();
    expect(resolveRepoName(undefined, repos)).toBeNull();
  });
});

describe("assignChildRepos — decompose output → per-child repo", () => {
  const knownRepos = ["web", "api"];

  it("maps each child's suggested repo to its canonical known repo", () => {
    const assignment = assignChildRepos(
      [
        { tempId: "c1", targetRepo: "web" },
        { tempId: "c2", targetRepo: "API" },
        { tempId: "c3", targetRepo: "apps/web" },
      ],
      knownRepos,
    );
    expect(assignment.get("c1")).toBe("web");
    expect(assignment.get("c2")).toBe("api");
    expect(assignment.get("c3")).toBe("web");
    expect(assignment.size).toBe(3);
  });

  it("omits children with no suggestion or an unknown repo", () => {
    const assignment = assignChildRepos(
      [
        { tempId: "c1", targetRepo: "web" },
        { tempId: "c2" },
        { tempId: "c3", targetRepo: null },
        { tempId: "c4", targetRepo: "mobile" },
      ],
      knownRepos,
    );
    expect(assignment.get("c1")).toBe("web");
    expect(assignment.has("c2")).toBe(false);
    expect(assignment.has("c3")).toBe(false);
    expect(assignment.has("c4")).toBe(false);
    expect(assignment.size).toBe(1);
  });

  it("assigns nothing for single-repo projects (no behaviour change)", () => {
    expect(assignChildRepos([{ tempId: "c1", targetRepo: "web" }], ["web"]).size).toBe(0);
    expect(assignChildRepos([{ tempId: "c1", targetRepo: "web" }], []).size).toBe(0);
  });
});
