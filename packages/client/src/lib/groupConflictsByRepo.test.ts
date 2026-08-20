import { describe, it, expect } from "vitest";
import {
  groupConflictsByRepo,
  formatConflictSummary,
  LEADING_REPO_LABEL,
} from "./groupConflictsByRepo.js";

describe("groupConflictsByRepo", () => {
  it("returns no groups for an empty list", () => {
    const g = groupConflictsByRepo([]);
    expect(g.total).toBe(0);
    expect(g.groups).toEqual([]);
    expect(formatConflictSummary(g)).toBe("");
  });

  it("groups un-prefixed files under the leading label", () => {
    const g = groupConflictsByRepo(["pkg.json", "src/index.ts"]);
    expect(g.total).toBe(2);
    expect(g.groups).toEqual([
      { repo: LEADING_REPO_LABEL, files: ["pkg.json", "src/index.ts"] },
    ]);
  });

  it("parses the `name::file` prefix into per-repo groups", () => {
    const g = groupConflictsByRepo(["auth-svc::src/server.js", "auth-svc::src/db.js"]);
    expect(g.groups).toEqual([
      { repo: "auth-svc", files: ["src/server.js", "src/db.js"] },
    ]);
  });

  it("orders siblings alphabetically with leading last (matches the summary example)", () => {
    const g = groupConflictsByRepo([
      "pkg.json", // leading
      "auth-svc::src/server.js",
      "auth-svc::src/db.js",
      "billing::a.ts",
    ]);
    expect(g.groups.map((x) => x.repo)).toEqual(["auth-svc", "billing", LEADING_REPO_LABEL]);
    expect(formatConflictSummary(g)).toBe("auth-svc 2, billing 1, leading 1");
    expect(g.total).toBe(4);
  });

  it("splits on the FIRST `::` only, keeping the rest of the path intact", () => {
    const g = groupConflictsByRepo(["repo::weird::name.ts"]);
    expect(g.groups).toEqual([{ repo: "repo", files: ["weird::name.ts"] }]);
  });
});
