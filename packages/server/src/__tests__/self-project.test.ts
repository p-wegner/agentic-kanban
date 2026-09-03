import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSelfProjectRepo, resolveSelfRoot } from "../services/self-project.js";

describe("isSelfProjectRepo", () => {
  const selfRoot = "C:/projects/andrena/agentic-kanban";

  it("matches the board's own checkout", () => {
    expect(isSelfProjectRepo("C:/projects/andrena/agentic-kanban", selfRoot)).toBe(true);
  });

  // Separator direction and case-folding are WINDOWS semantics; `pathKey` applies them only
  // on win32 (off it, `.../AGENTIC-KANBAN` is a different directory). #828 — this had never
  // run off Windows, where it fails.
  it.runIf(process.platform === "win32")("is slash/case/trailing-slash insensitive (win32)", () => {
    expect(isSelfProjectRepo("C:\\projects\\andrena\\agentic-kanban\\", selfRoot)).toBe(true);
    expect(isSelfProjectRepo("c:/projects/andrena/AGENTIC-KANBAN", selfRoot)).toBe(true);
  });

  it("is trailing-slash insensitive on every platform", () => {
    expect(isSelfProjectRepo(`${selfRoot}/`, selfRoot)).toBe(true);
  });

  it("rejects a different project's repo", () => {
    expect(isSelfProjectRepo("C:/projects/andrena/some-other-app", selfRoot)).toBe(false);
  });

  it("rejects a nested/worktree path that isn't the checkout root", () => {
    // A worktree lives UNDER the repo; the project's stored repoPath is the root, so a
    // path with an extra segment is not the self repo.
    expect(isSelfProjectRepo("C:/projects/andrena/agentic-kanban/.worktrees/feature_x", selfRoot)).toBe(false);
  });

  it("returns false for null/empty repoPath", () => {
    expect(isSelfProjectRepo(null, selfRoot)).toBe(false);
    expect(isSelfProjectRepo(undefined, selfRoot)).toBe(false);
    expect(isSelfProjectRepo("", selfRoot)).toBe(false);
  });
});

describe("resolveSelfRoot (#1010) — the checkout root, not the backend's packages/server cwd", () => {
  it("walks up from packages/server to the monorepo root", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-self-root-"));
    try {
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
      mkdirSync(join(root, "packages", "server"), { recursive: true });
      const serverDir = join(root, "packages", "server");
      expect(resolveSelfRoot(serverDir)).toBe(root);
      expect(resolveSelfRoot(root)).toBe(root);
      // The comparison the gate actually makes: the project's repoPath IS the root, the
      // backend's cwd is packages/server — that pair must resolve as self.
      expect(isSelfProjectRepo(root, resolveSelfRoot(serverDir))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the start dir when nothing above looks like the monorepo (packaged install)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-self-root-none-"));
    try {
      expect(resolveSelfRoot(dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
