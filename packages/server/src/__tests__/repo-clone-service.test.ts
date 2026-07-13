// @covers projects.register.cloneUrl [config]
//
// Clone-from-URL registration (server deployments): repos land under a configurable
// repos root instead of requiring a pre-existing local path. These tests cover the
// pure parts — URL → directory-name derivation and repos-root resolution; the actual
// `git clone` is exercised by registering a real repo in integration/verification.

import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { getReposRoot, repoDirNameFromUrl } from "../services/repo-clone.service.js";
import { DATA_DIR } from "../db/data-dir.js";

describe("repoDirNameFromUrl", () => {
  it("uses the URL basename minus .git", () => {
    expect(repoDirNameFromUrl("https://github.com/user/my-repo.git")).toBe("my-repo");
    expect(repoDirNameFromUrl("https://github.com/user/my-repo")).toBe("my-repo");
    expect(repoDirNameFromUrl("git@github.com:user/my-repo.git")).toBe("my-repo");
  });

  it("survives trailing slashes and sanitizes unsafe characters", () => {
    expect(repoDirNameFromUrl("https://example.com/group/repo/")).toBe("repo");
    expect(repoDirNameFromUrl("https://example.com/we ird&name.git")).toBe("we-ird-name");
  });

  it("rejects URLs it cannot derive a name from", () => {
    expect(() => repoDirNameFromUrl("https://example.com/...")).toThrow(/Cannot derive/);
  });
});

describe("getReposRoot", () => {
  const saved = process.env.KANBAN_REPOS_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.KANBAN_REPOS_DIR;
    else process.env.KANBAN_REPOS_DIR = saved;
  });

  it("prefers KANBAN_REPOS_DIR", () => {
    process.env.KANBAN_REPOS_DIR = join("some", "explicit", "root");
    expect(getReposRoot()).toBe(join("some", "explicit", "root"));
  });

  it("falls back to <data dir>/repos", () => {
    delete process.env.KANBAN_REPOS_DIR;
    expect(getReposRoot()).toBe(join(DATA_DIR, "repos"));
  });
});
