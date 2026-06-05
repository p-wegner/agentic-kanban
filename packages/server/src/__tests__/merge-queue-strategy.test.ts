import { describe, it, expect } from "vitest";
import {
  classifyReconcileStrategies,
  type OverlapEntry,
  type WorkspaceConflictPreview,
  type MigrationCollisionEntry,
} from "../services/merge-queue.service.js";

const infos = (...ids: string[]) => ids.map((id) => ({ id }));
const clean = (id: string): WorkspaceConflictPreview => ({ id, workspaceId: id, hasConflicts: false, conflictingFiles: [], isStale: false } as WorkspaceConflictPreview);
const conflicted = (id: string, files: string[]): WorkspaceConflictPreview => ({ workspaceId: id, hasConflicts: true, conflictingFiles: files, isStale: false });
const stale = (id: string): WorkspaceConflictPreview => ({ workspaceId: id, hasConflicts: false, conflictingFiles: [], isStale: true });
const overlap = (a: string, b: string, files: string[]): OverlapEntry => ({ workspaceIdA: a, workspaceIdB: b, overlapCount: files.length, files });
const noOverlap = (a: string, b: string): OverlapEntry => ({ workspaceIdA: a, workspaceIdB: b, overlapCount: 0, files: [] });

describe("classifyReconcileStrategies", () => {
  it("independent + clean → direct, no clusters", () => {
    const r = classifyReconcileStrategies(infos("a", "b"), [noOverlap("a", "b")], [clean("a"), clean("b")], []);
    expect(r.clusters).toHaveLength(0);
    expect(r.recommendedStrategy).toBe("direct");
  });

  it("stale-only with no overlap → rebase", () => {
    const r = classifyReconcileStrategies(infos("a", "b"), [noOverlap("a", "b")], [stale("a"), clean("b")], []);
    expect(r.recommendedStrategy).toBe("rebase");
  });

  it("migration collision → sequence-migrations", () => {
    const collisions: MigrationCollisionEntry[] = [
      { migrationNumber: "0061", workspaces: [
        { workspaceId: "a", issueNumber: 1, issueTitle: "", files: [] },
        { workspaceId: "b", issueNumber: 2, issueTitle: "", files: [] },
      ] },
    ];
    const r = classifyReconcileStrategies(infos("a", "b"), [noOverlap("a", "b")], [clean("a"), clean("b")], collisions);
    expect(r.recommendedStrategy).toBe("sequence-migrations");
  });

  it("overlapping cluster, no conflict → integration-union; members grouped", () => {
    const r = classifyReconcileStrategies(
      infos("a", "b", "c"),
      [overlap("a", "b", ["x.ts"]), overlap("b", "c", ["x.ts"]), noOverlap("a", "c")],
      [clean("a"), clean("b"), clean("c")],
      [],
    );
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0].workspaceIds.sort()).toEqual(["a", "b", "c"]);
    expect(r.clusters[0].sharedFiles).toContain("x.ts");
    expect(r.recommendedStrategy).toBe("integration-union");
  });

  it("overlapping cluster WITH a semantic conflict → agent-reapply-intent", () => {
    const r = classifyReconcileStrategies(
      infos("a", "b"),
      [overlap("a", "b", ["git-service.ts"])],
      [conflicted("a", ["git-service.ts"]), clean("b")],
      [],
    );
    expect(r.clusters[0].hasConflicts).toBe(true);
    expect(r.clusters[0].strategy).toBe("agent-reapply-intent");
    expect(r.recommendedStrategy).toBe("agent-reapply-intent");
  });

  it("picks the HARDEST strategy when several apply (cluster-conflict beats migration)", () => {
    const collisions: MigrationCollisionEntry[] = [
      { migrationNumber: "0061", workspaces: [{ workspaceId: "a", issueNumber: 1, issueTitle: "", files: [] }] },
    ];
    const r = classifyReconcileStrategies(
      infos("a", "b"),
      [overlap("a", "b", ["hub.ts"])],
      [conflicted("a", ["hub.ts"]), clean("b")],
      collisions,
    );
    expect(r.recommendedStrategy).toBe("agent-reapply-intent");
  });

  it("two separate clusters are detected independently", () => {
    const r = classifyReconcileStrategies(
      infos("a", "b", "c", "d"),
      [overlap("a", "b", ["x.ts"]), overlap("c", "d", ["y.ts"]), noOverlap("a", "c")],
      [clean("a"), clean("b"), clean("c"), clean("d")],
      [],
    );
    expect(r.clusters).toHaveLength(2);
  });
});
