import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import {
  buildReviewContext,
  buildConflictContext,
  extractConflictRegions,
} from "../services/phase-context.service.js";
import { buildReviewPrompt } from "../services/review.service.js";
import { buildConflictResolutionPrompt } from "../services/merge-helpers.service.js";
import { createTestDb } from "./helpers/test-db.js";

// #128: 56% of builder sessions were cold review/reconcile phases that rebuilt a
// 65k+ context by re-running `git diff` and re-reading the tree. The board already
// knows what changed, so it now hands the phase agent a pre-computed context block.

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ak-phase-ctx-"));
  const git = (...args: string[]) => gitExecSync(args, { cwd: repo, stdio: "pipe" });
  git("init", "-b", "master");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "base.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-m", "base");
  git("checkout", "-b", "feature/x");
  writeFileSync(join(repo, "base.ts"), "export const a = 2;\n");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "added.ts"), "export const b = 3;\n");
  git("add", "-A");
  git("commit", "-m", "change");
  // An untracked file — the reviewer must see it, since it is part of the change.
  writeFileSync(join(repo, "untracked.ts"), "export const c = 4;\n");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("buildReviewContext", () => {
  it("lists every changed file with line counts and inlines the diff", async () => {
    const ctx = await buildReviewContext({ workingDir: repo, baseRef: "master" });
    expect(ctx).not.toBeNull();
    expect(ctx).toContain("PRE-COMPUTED CONTEXT");
    expect(ctx).toContain("base.ts");
    expect(ctx).toContain("src/added.ts");
    // untracked files are part of the change and must not be silently dropped
    expect(ctx).toContain("untracked.ts");
    // the actual diff body is inlined so the agent never runs git diff itself
    expect(ctx).toContain("export const a = 2;");
    expect(ctx).toContain("```diff");
  });

  it("omits the diff (never truncates it) when it exceeds the budget, keeping the file list", async () => {
    const ctx = await buildReviewContext({ workingDir: repo, baseRef: "master", maxDiffChars: 10 });
    expect(ctx).not.toBeNull();
    // A half-diff would make the reviewer silently review half a change.
    expect(ctx).not.toContain("```diff");
    expect(ctx).toContain("exceeds the 10-char inline budget");
    expect(ctx).toContain("src/added.ts");
  });

  it("returns null when nothing changed, so the caller keeps the legacy prompt", async () => {
    const clean = mkdtempSync(join(tmpdir(), "ak-phase-ctx-clean-"));
    try {
      const git = (...args: string[]) => gitExecSync(args, { cwd: clean, stdio: "pipe" });
      git("init", "-b", "master");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      writeFileSync(join(clean, "only.ts"), "export const a = 1;\n");
      git("add", "-A");
      git("commit", "-m", "base");
      expect(await buildReviewContext({ workingDir: clean, baseRef: "master" })).toBeNull();
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });

  it("returns null instead of throwing when the directory is not a git repo", async () => {
    const empty = mkdtempSync(join(tmpdir(), "ak-phase-ctx-empty-"));
    try {
      expect(await buildReviewContext({ workingDir: empty, baseRef: "master" })).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("buildReviewPrompt precomputed context", () => {
  it("substitutes the context into the {{precomputedContext}} placeholder", async () => {
    const { db } = createTestDb();
    const { prompt } = await buildReviewPrompt(
      db, "feature/x", "master", "issue-1", true, undefined, undefined, undefined, "ws-1",
      "code-review", "none", "PRE-COMPUTED CONTEXT\nsrc/added.ts",
    );
    expect(prompt).toContain("PRE-COMPUTED CONTEXT");
    expect(prompt).toContain("src/added.ts");
    expect(prompt).not.toContain("{{precomputedContext}}");
    // the cold-start instruction is replaced, not merely appended to
    expect(prompt).not.toContain("run 'git diff --stat master'");
  });

  it("falls back to the discover-it-yourself instruction when no context could be computed", async () => {
    const { db } = createTestDb();
    const { prompt } = await buildReviewPrompt(
      db, "feature/x", "master", "issue-1", true, undefined, undefined, undefined, "ws-1",
      "code-review", "none", null,
    );
    expect(prompt).toContain("git diff --stat master");
    expect(prompt).toContain("git diff master -- <filepath>");
    expect(prompt).not.toContain("{{precomputedContext}}");
    expect(prompt).not.toContain("{{baseBranch}}");
  });

  it("does not expand placeholder-looking text that appears inside the reviewed diff", async () => {
    const { db } = createTestDb();
    const diffish = "+const t = '{{baseBranch}}';\n+const u = '{{workspaceId}}';";
    const { prompt } = await buildReviewPrompt(
      db, "feature/x", "master", "issue-1", true, undefined, undefined, undefined, "ws-1",
      "code-review", "none", diffish,
    );
    // Reviewed source must reach the agent verbatim — expanding it would show a
    // reviewer code that does not exist in the repo.
    expect(prompt).toContain("'{{baseBranch}}'");
    expect(prompt).toContain("'{{workspaceId}}'");
  });
});

describe("conflict context", () => {
  const conflicted = [
    "line one",
    "line two",
    "<<<<<<< HEAD",
    "ours",
    "=======",
    "theirs",
    ">>>>>>> feature/x",
    "line eight",
  ].join("\n");

  it("extracts each conflict region with surrounding context and line numbers", () => {
    const regions = extractConflictRegions(conflicted);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toContain("<<<<<<< HEAD");
    expect(regions[0]).toContain("ours");
    expect(regions[0]).toContain("theirs");
    expect(regions[0]).toContain(">>>>>>> feature/x");
    // surrounding context is included so the agent can resolve without opening the file
    expect(regions[0]).toContain("line two");
    expect(regions[0]).toMatch(/\s3\|/);
  });

  it("finds multiple regions in one file", () => {
    const two = conflicted + "\n" + conflicted;
    expect(extractConflictRegions(two)).toHaveLength(2);
  });

  it("returns no regions for a clean file", () => {
    expect(extractConflictRegions("all\nfine\n")).toHaveLength(0);
  });

  it("builds a context block from the files on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-conflict-"));
    try {
      writeFileSync(join(dir, "conflicted.ts"), conflicted);
      const ctx = await buildConflictContext(dir, ["conflicted.ts"]);
      expect(ctx).toContain("PRE-COMPUTED CONTEXT");
      expect(ctx).toContain("### conflicted.ts (1 conflict region)");
      expect(ctx).toContain("<<<<<<< HEAD");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no listed file actually has markers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-conflict-clean-"));
    try {
      writeFileSync(join(dir, "clean.ts"), "no markers here\n");
      expect(await buildConflictContext(dir, ["clean.ts"])).toBeNull();
      expect(await buildConflictContext(dir, ["missing.ts"])).toBeNull();
      expect(await buildConflictContext(dir, [])).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("embeds the hunks in the resolution prompt, and stays valid without them", () => {
    const withCtx = buildConflictResolutionPrompt(["a.ts"], "master", "HUNKS HERE");
    expect(withCtx).toContain("HUNKS HERE");
    expect(withCtx).toContain("Base branch: master");

    const withoutCtx = buildConflictResolutionPrompt(["a.ts"], "master", null);
    expect(withoutCtx).toContain("- a.ts");
    expect(withoutCtx).toContain("Base branch: master");
    expect(withoutCtx).not.toContain("PRE-COMPUTED");
  });
});
