import { describe, it, expect } from "vitest";
import type { RepoMergeStatusResponse, ServiceStackState } from "@agentic-kanban/shared";
import { summarizeMultirepoHealth } from "./summarizeMultirepoHealth.js";

function repoEntry(over: Partial<RepoMergeStatusResponse["repos"][number]> = {}) {
  return {
    name: null,
    path: "/repo",
    isLeading: true,
    hasWork: true,
    ahead: 0,
    merged: true,
    stranded: false,
    ...over,
  };
}

function mergeStatus(over: Partial<RepoMergeStatusResponse> = {}): RepoMergeStatusResponse {
  return {
    branch: "feature/x",
    baseBranch: "master",
    allMerged: true,
    repos: [
      repoEntry({ name: null, isLeading: true }),
      repoEntry({ name: "auth-svc", isLeading: false }),
      repoEntry({ name: "billing", isLeading: false }),
    ],
    ...over,
  };
}

function stack(over: Partial<ServiceStackState> = {}): ServiceStackState {
  return {
    composeProjectName: "ws-abc",
    ports: { web: 3001, db: 5432, redis: 6379 },
    envFilePath: "/tmp/.env",
    status: "up",
    updatedAt: "2026-07-18T00:00:00.000Z",
    ...over,
  };
}

describe("summarizeMultirepoHealth", () => {
  it("returns null for a missing merge status (not yet fetched)", () => {
    expect(summarizeMultirepoHealth({})).toBeNull();
    expect(summarizeMultirepoHealth({ repoMergeStatus: null })).toBeNull();
  });

  it("returns null for a single-repo workspace", () => {
    const single = mergeStatus({ repos: [repoEntry()] });
    expect(summarizeMultirepoHealth({ repoMergeStatus: single })).toBeNull();
  });

  it("summarizes a healthy all-merged multi-repo workspace with a running stack", () => {
    const s = summarizeMultirepoHealth({ repoMergeStatus: mergeStatus(), serviceState: stack() });
    expect(s).not.toBeNull();
    expect(s!.severity).toBe("healthy");
    expect(s!.repoCount).toBe(3);
    expect(s!.strandedCount).toBe(0);
    expect(s!.allMerged).toBe(true);
    expect(s!.stack).toEqual({ status: "up", serviceCount: 3 });
    expect(s!.text).toBe("3 repos · all merged · stack up(3)");
  });

  it("is red (attention) and counts stranded repos", () => {
    const status = mergeStatus({
      allMerged: false,
      repos: [
        repoEntry({ name: null, isLeading: true, merged: true }),
        repoEntry({ name: "auth-svc", isLeading: false, merged: false, stranded: true, ahead: 2 }),
        repoEntry({ name: "billing", isLeading: false, merged: false, stranded: true, ahead: 1 }),
      ],
    });
    const s = summarizeMultirepoHealth({ repoMergeStatus: status, serviceState: stack() })!;
    expect(s.severity).toBe("attention");
    expect(s.strandedCount).toBe(2);
    expect(s.text).toBe("3 repos · 2 stranded · stack up(3)");
  });

  it("is red when a conflict is present even if everything merged", () => {
    const s = summarizeMultirepoHealth({ repoMergeStatus: mergeStatus(), hasConflicts: true })!;
    expect(s.severity).toBe("attention");
    expect(s.hasConflicts).toBe(true);
    expect(s.text).toBe("3 repos · all merged · conflict");
  });

  it("is red when the service stack failed to start", () => {
    const s = summarizeMultirepoHealth({
      repoMergeStatus: mergeStatus(),
      serviceState: stack({ status: "error", error: "boom" }),
    })!;
    expect(s.severity).toBe("attention");
    expect(s.stack).toEqual({ status: "error", serviceCount: 3 });
    expect(s.text).toBe("3 repos · all merged · stack error(3)");
  });

  it("treats a capacity-deferred stack as down, not an error", () => {
    const s = summarizeMultirepoHealth({
      repoMergeStatus: mergeStatus(),
      serviceState: stack({ status: "error", deferred: true, ports: {} }),
    })!;
    expect(s.stack).toEqual({ status: "down", serviceCount: 0 });
    // allMerged but stack not up -> neutral (not healthy, not attention)
    expect(s.severity).toBe("neutral");
    expect(s.text).toBe("3 repos · all merged · stack down");
  });

  it("is neutral when not all merged but nothing is stranded/conflicting", () => {
    const s = summarizeMultirepoHealth({
      repoMergeStatus: mergeStatus({ allMerged: false }),
    })!;
    expect(s.severity).toBe("neutral");
    expect(s.text).toBe("3 repos · not all merged");
  });

  it("is healthy with no stack when all repos merged", () => {
    const s = summarizeMultirepoHealth({ repoMergeStatus: mergeStatus() })!;
    expect(s.severity).toBe("healthy");
    expect(s.stack).toBeNull();
    expect(s.text).toBe("3 repos · all merged");
  });
});
