import { describe, it, expect } from "vitest";
import { isSelfProjectRepo } from "../services/self-project.js";

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
