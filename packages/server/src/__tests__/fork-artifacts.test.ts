import { describe, it, expect } from "vitest";
import {
  buildForkMergeSummary,
  buildForkHeaderJob,
  buildForkArtifactsDoc,
  buildJoinConsolidateLine,
  type ForkMergeResult,
} from "../lib/fork-artifacts.js";

describe("buildForkMergeSummary", () => {
  it("is empty for a non-merge join strategy", () => {
    expect(buildForkMergeSummary("manual", [{ branch: "a", status: "merged" }])).toBe("");
  });

  it("lists each branch result and a clean-merge footer when nothing conflicted", () => {
    const results: ForkMergeResult[] = [
      { branch: "feat/a", status: "merged" },
      { branch: "feat/b", status: "skipped", detail: "unknown" },
    ];
    const out = buildForkMergeSummary("merge", results);
    expect(out).toContain("## Auto-merge results");
    expect(out).toContain("- `feat/a`: **merged**");
    expect(out).toContain("- `feat/b`: **skipped** — unknown");
    expect(out).toContain("All branches were merged into this branch automatically.");
    expect(out).not.toContain("did NOT merge cleanly");
  });

  it("emits the conflict footer with the unmerged count when a branch conflicted", () => {
    const results: ForkMergeResult[] = [
      { branch: "feat/a", status: "merged" },
      { branch: "feat/b", status: "conflict", detail: "CONFLICT in x.ts" },
    ];
    const out = buildForkMergeSummary("merge", results);
    expect(out).toContain("- `feat/b`: **conflict** — CONFLICT in x.ts");
    expect(out).toContain("1 branch(es) did NOT merge cleanly");
    expect(out).not.toContain("All branches were merged");
  });
});

describe("buildForkHeaderJob", () => {
  it("describes sequential shared-branch stages in shared mode", () => {
    expect(buildForkHeaderJob(true, "merge", 3, "Consolidate")).toBe(
      `3 fork stage(s) ran sequentially on this shared branch; all their work is already committed here. Your job at this **Consolidate** stage: verify the combined result is coherent, then advance the workflow.`,
    );
  });

  it("describes auto-merged parallel branches in merge mode", () => {
    expect(buildForkHeaderJob(false, "merge", 2, "Join")).toBe(
      `2 parallel branch(es) completed and were auto-merged into this branch. Your job at this **Join** stage: verify the combined result is coherent, integrate any branches that failed to merge (listed above), then advance the workflow.`,
    );
  });

  it("asks the agent to consolidate by hand in manual mode", () => {
    expect(buildForkHeaderJob(false, "manual", 2, "Join")).toBe(
      `2 parallel branch(es) completed. Your job at this **Join** stage: review each branch's diff below, consolidate them into a single coherent result on this (parent) branch, resolve any overlaps, and then advance the workflow.`,
    );
  });
});

describe("buildForkArtifactsDoc", () => {
  it("assembles title, issue line (with em-dash), header job, merge summary, then sections", () => {
    const doc = buildForkArtifactsDoc({
      issueNumber: 42,
      issueTitle: "My epic",
      joinNodeName: "Join",
      childrenCount: 2,
      joinStrategy: "merge",
      sharedWorktree: false,
      mergeResults: [{ branch: "feat/a", status: "merged" }],
      sections: ["### Branch: feat/a", "### Branch: feat/b"],
    });
    expect(doc.startsWith("# Parallel fork artifacts\n\n")).toBe(true);
    expect(doc).toContain(`Issue #42 — "My epic"`);
    expect(doc).toContain("were auto-merged into this branch");
    expect(doc).toContain("## Auto-merge results");
    // sections joined with the horizontal-rule separator
    expect(doc).toContain("### Branch: feat/a\n\n---\n\n### Branch: feat/b");
  });

  it("uses the shared-mode header job (sequential-stages wording) when sharedWorktree is true", () => {
    const doc = buildForkArtifactsDoc({
      issueNumber: 7,
      issueTitle: "Shared epic",
      joinNodeName: "Join",
      childrenCount: 3,
      joinStrategy: "manual",
      sharedWorktree: true,
      mergeResults: [],
      sections: ["### Branch: x"],
    });
    expect(doc).toContain("3 fork stage(s) ran sequentially on this shared branch");
    expect(doc).toContain(`Issue #7 — "Shared epic"`);
    expect(doc).not.toContain("## Auto-merge results"); // manual strategy → no merge summary
  });

  it("renders '#?' when the issue has no number, and omits the merge summary for manual joins", () => {
    const doc = buildForkArtifactsDoc({
      issueNumber: null,
      issueTitle: "Untitled",
      joinNodeName: "Join",
      childrenCount: 1,
      joinStrategy: "manual",
      sharedWorktree: false,
      mergeResults: [],
      sections: ["### Branch: x"],
    });
    expect(doc).toContain(`Issue #? — "Untitled"`);
    expect(doc).not.toContain("## Auto-merge results");
  });
});

describe("buildJoinConsolidateLine", () => {
  it("shared mode: already-committed wording", () => {
    expect(buildJoinConsolidateLine(true, "merge", 0)).toBe(
      `The fork stages ran sequentially on this branch, so all their work is already committed here. Verify the combined result is coherent, then advance the workflow.`,
    );
  });

  it("merge mode with no conflicts: no integrate clause", () => {
    expect(buildJoinConsolidateLine(false, "merge", 0)).toBe(
      `The parallel branches have already been auto-merged into this branch. Verify the combined result is coherent, then advance the workflow.`,
    );
  });

  it("merge mode with conflicts: includes the integrate clause + count", () => {
    expect(buildJoinConsolidateLine(false, "merge", 2)).toBe(
      `The parallel branches have already been auto-merged into this branch. Verify the combined result is coherent, integrate the 2 branch(es) that failed to merge (see the artifacts), then advance the workflow.`,
    );
  });

  it("manual mode: plain consolidate wording", () => {
    expect(buildJoinConsolidateLine(false, "manual", 0)).toBe(
      `Consolidate the branches into a single coherent result on this branch, then advance the workflow.`,
    );
  });
});
