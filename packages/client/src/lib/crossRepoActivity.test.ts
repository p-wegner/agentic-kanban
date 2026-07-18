import { describe, it, expect } from "vitest";
import type { RepoMergeStatusResponse, RepoMergeStatusRepoEntry } from "@agentic-kanban/shared";
import {
  reduceRepoMergeStatusDelta,
  reduceConflictsDelta,
  appendActivityEntries,
  type CrossRepoActivityContext,
  type CrossRepoActivityEntry,
} from "./crossRepoActivity.js";

const ctx: CrossRepoActivityContext = {
  workspaceId: "ws1",
  issueId: "iss1",
  issueNumber: 88,
  timestamp: "2026-07-18T10:00:00.000Z",
  baseBranch: "master",
};

function repo(over: Partial<RepoMergeStatusRepoEntry> & { path: string }): RepoMergeStatusRepoEntry {
  return {
    name: null,
    isLeading: false,
    hasWork: false,
    ahead: 0,
    merged: false,
    stranded: false,
    ...over,
  };
}

function status(repos: RepoMergeStatusRepoEntry[]): RepoMergeStatusResponse {
  return { branch: "feature/x", baseBranch: "master", allMerged: repos.every((r) => !r.hasWork || r.merged), repos };
}

describe("reduceRepoMergeStatusDelta", () => {
  it("emits nothing on first observation (null prev baseline)", () => {
    const next = status([repo({ path: "/lead", isLeading: true, hasWork: true, merged: true })]);
    expect(reduceRepoMergeStatusDelta(null, next, ctx)).toEqual([]);
  });

  it("emits nothing when a repo's state is unchanged (dedupe of repeated events)", () => {
    const s = status([repo({ path: "/auth", name: "auth-svc", hasWork: true, ahead: 2 })]);
    expect(reduceRepoMergeStatusDelta(s, s, ctx)).toEqual([]);
  });

  it("emits a repo-labeled merged entry when a sibling lands", () => {
    const prev = status([repo({ path: "/auth", name: "auth-svc", hasWork: true, ahead: 2, stranded: true })]);
    const next = status([repo({ path: "/auth", name: "auth-svc", hasWork: true, ahead: 0, merged: true })]);
    const entries = reduceRepoMergeStatusDelta(prev, next, ctx);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "ws1:auth-svc:repo_merged",
      repo: "auth-svc",
      kind: "repo_merged",
      workspaceId: "ws1",
      issueNumber: 88,
    });
    expect(entries[0].summary).toBe("#88 auth-svc merged into master");
  });

  it("labels the un-named leading repo with the leading sentinel", () => {
    const prev = status([repo({ path: "/lead", isLeading: true, hasWork: true, ahead: 1 })]);
    const next = status([repo({ path: "/lead", isLeading: true, hasWork: true, ahead: 0, merged: true })]);
    const entries = reduceRepoMergeStatusDelta(prev, next, ctx);
    expect(entries[0].repo).toBe("leading");
    expect(entries[0].id).toBe("ws1:leading:repo_merged");
  });

  it("emits a stranded entry when work fails to land", () => {
    const prev = status([repo({ path: "/auth", name: "auth-svc", hasWork: true, ahead: 3 })]);
    const next = status([repo({ path: "/auth", name: "auth-svc", hasWork: true, ahead: 3, stranded: true })]);
    const entries = reduceRepoMergeStatusDelta(prev, next, ctx);
    expect(entries[0].kind).toBe("repo_stranded");
    expect(entries[0].summary).toContain("stranded");
  });

  it("emits an advanced entry when a repo gains unlanded commits", () => {
    const prev = status([repo({ path: "/auth", name: "auth-svc", hasWork: false })]);
    const next = status([repo({ path: "/auth", name: "auth-svc", hasWork: true, ahead: 2 })]);
    const entries = reduceRepoMergeStatusDelta(prev, next, ctx);
    expect(entries[0].kind).toBe("repo_ahead");
    expect(entries[0].summary).toContain("2 ahead");
  });

  it("emits per-repo entries independently in one delta", () => {
    const prev = status([
      repo({ path: "/lead", isLeading: true, hasWork: true, ahead: 1 }),
      repo({ path: "/auth", name: "auth-svc", hasWork: true, ahead: 1 }),
    ]);
    const next = status([
      repo({ path: "/lead", isLeading: true, hasWork: true, ahead: 0, merged: true }),
      repo({ path: "/auth", name: "auth-svc", hasWork: true, ahead: 1, stranded: true }),
    ]);
    const entries = reduceRepoMergeStatusDelta(prev, next, ctx);
    expect(entries.map((e) => e.kind).sort()).toEqual(["repo_merged", "repo_stranded"]);
  });
});

describe("reduceConflictsDelta", () => {
  it("emits nothing on first observation", () => {
    expect(reduceConflictsDelta(null, ["auth-svc::a.ts"], ctx)).toEqual([]);
  });

  it("emits a conflict_appeared entry labeled by repo", () => {
    const entries = reduceConflictsDelta([], ["auth-svc::src/db.js"], ctx);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ repo: "auth-svc", kind: "conflict_appeared", id: "ws1:auth-svc:conflict_appeared" });
  });

  it("emits a conflict_cleared entry when a repo's conflict resolves", () => {
    const entries = reduceConflictsDelta(["auth-svc::src/db.js"], [], ctx);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("conflict_cleared");
  });

  it("a conflict appearing then clearing produces two distinct entries", () => {
    const appear = reduceConflictsDelta([], ["auth-svc::a.ts"], ctx);
    const clear = reduceConflictsDelta(["auth-svc::a.ts"], [], ctx);
    expect(appear).toHaveLength(1);
    expect(clear).toHaveLength(1);
    expect(appear[0].id).not.toBe(clear[0].id);
    expect([appear[0].kind, clear[0].kind]).toEqual(["conflict_appeared", "conflict_cleared"]);
  });

  it("labels the leading repo's un-prefixed conflicts with the leading sentinel", () => {
    const entries = reduceConflictsDelta([], ["pkg.json"], ctx);
    expect(entries[0].repo).toBe("leading");
  });
});

describe("appendActivityEntries", () => {
  const e = (id: string, timestamp: string): CrossRepoActivityEntry => ({
    id, timestamp, repo: "auth-svc", kind: "repo_merged", summary: id, workspaceId: "ws1", issueId: null, issueNumber: null,
  });

  it("dedupes entries whose id is already present", () => {
    const existing = [e("a", "2026-07-18T10:00:00.000Z")];
    const merged = appendActivityEntries(existing, [e("a", "2026-07-18T10:05:00.000Z")]);
    expect(merged).toHaveLength(1);
    expect(merged[0].timestamp).toBe("2026-07-18T10:00:00.000Z");
  });

  it("prepends fresh entries newest-first", () => {
    const existing = [e("a", "2026-07-18T10:00:00.000Z")];
    const merged = appendActivityEntries(existing, [e("b", "2026-07-18T10:05:00.000Z")]);
    expect(merged.map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("caps to the recent window", () => {
    const existing = Array.from({ length: 5 }, (_, i) => e(`old${i}`, `2026-07-18T09:0${i}:00.000Z`));
    const merged = appendActivityEntries(existing, [e("new", "2026-07-18T10:00:00.000Z")], 3);
    expect(merged).toHaveLength(3);
    expect(merged[0].id).toBe("new");
  });
});
