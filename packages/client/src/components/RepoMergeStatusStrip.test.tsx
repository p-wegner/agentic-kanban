import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RepoMergeStatusStripView } from "./RepoMergeStatusStrip.js";
import type { RepoMergeStatusResponse, RepoMergeStatusRepoEntry } from "@agentic-kanban/shared";

function repo(overrides: Partial<RepoMergeStatusRepoEntry>): RepoMergeStatusRepoEntry {
  return {
    name: null,
    path: "/repo/leading",
    isLeading: true,
    hasWork: false,
    ahead: 0,
    merged: false,
    stranded: false,
    ...overrides,
  };
}

function status(overrides: Partial<RepoMergeStatusResponse>): RepoMergeStatusResponse {
  return {
    branch: "feature/ak-1-x",
    baseBranch: "master",
    allMerged: false,
    repos: [],
    ...overrides,
  };
}

describe("RepoMergeStatusStripView", () => {
  it("renders nothing without status or for a single-repo workspace", () => {
    expect(renderToStaticMarkup(<RepoMergeStatusStripView status={null} />)).toBe("");
    expect(
      renderToStaticMarkup(
        <RepoMergeStatusStripView status={status({ repos: [repo({ hasWork: true, ahead: 2, stranded: true })] })} />,
      ),
    ).toBe("");
  });

  it("renders one row per repo with 'leading' label, no-changes, merged, and stranded states", () => {
    const html = renderToStaticMarkup(
      <RepoMergeStatusStripView
        status={status({
          repos: [
            repo({ hasWork: false }),
            repo({ name: "auth-svc", path: "/repo/auth-svc", isLeading: false, hasWork: true, ahead: 0, merged: true }),
            repo({ name: "inventory-svc", path: "/repo/inventory-svc", isLeading: false, hasWork: true, ahead: 3, stranded: true }),
          ],
        })}
      />,
    );

    expect(html).toContain("leading");
    expect(html).toContain("no changes");
    expect(html).toContain("auth-svc");
    expect(html).toContain("merged");
    expect(html).toContain("inventory-svc");
    expect(html).toContain("3 ahead");
    expect(html).toContain("1 unmerged");
    expect(html).toContain("master");
  });

  it("renders the allMerged summary when every worked repo has landed", () => {
    const html = renderToStaticMarkup(
      <RepoMergeStatusStripView
        status={status({
          allMerged: true,
          repos: [
            repo({ hasWork: true, ahead: 0, merged: true }),
            repo({ name: "auth-svc", path: "/repo/auth-svc", isLeading: false, hasWork: true, ahead: 0, merged: true }),
          ],
        })}
      />,
    );

    expect(html).toContain("all merged");
    expect(html).not.toContain("unmerged");
    expect(html).not.toContain("ahead");
  });

  it("stays read-only (no action buttons) when no callbacks are supplied", () => {
    const html = renderToStaticMarkup(
      <RepoMergeStatusStripView
        status={status({ repos: [repo({ hasWork: true, ahead: 2, stranded: true }), repo({ name: "svc", path: "/repo/svc", isLeading: false, hasWork: true, ahead: 1, stranded: true })] })}
      />,
    );
    expect(html).not.toContain("repo-rebase-button");
    expect(html).not.toContain("retry-merge-button");
  });

  it("shows a per-repo rebase button on stranded repos and a workspace retry-merge button when callbacks are supplied", () => {
    const html = renderToStaticMarkup(
      <RepoMergeStatusStripView
        status={status({
          repos: [
            repo({ hasWork: false }),
            repo({ name: "svc", path: "/repo/svc", isLeading: false, hasWork: true, ahead: 2, stranded: true }),
          ],
        })}
        onRebaseRepo={() => {}}
        onRetryMerge={() => {}}
      />,
    );
    // Rebase button only on the stranded sibling, not the no-changes leading row.
    expect(html.match(/repo-rebase-button/g) ?? []).toHaveLength(1);
    expect(html).toContain("Rebase onto base");
    expect(html).toContain("retry-merge-button");
    expect(html).toContain("Retry merge");
  });

  it("hides the retry-merge button once all repos are merged", () => {
    const html = renderToStaticMarkup(
      <RepoMergeStatusStripView
        status={status({ allMerged: true, repos: [repo({ hasWork: true, ahead: 0, merged: true }), repo({ name: "svc", path: "/repo/svc", isLeading: false, hasWork: true, ahead: 0, merged: true })] })}
        onRebaseRepo={() => {}}
        onRetryMerge={() => {}}
      />,
    );
    expect(html).not.toContain("retry-merge-button");
    expect(html).not.toContain("repo-rebase-button");
  });

  it("surfaces per-repo rebase progress and conflict results", () => {
    const running = renderToStaticMarkup(
      <RepoMergeStatusStripView
        status={status({ repos: [repo({ hasWork: false }), repo({ name: "svc", path: "/repo/svc", isLeading: false, hasWork: true, ahead: 2, stranded: true })] })}
        onRebaseRepo={() => {}}
        actionState={{ svc: { phase: "running" } }}
      />,
    );
    expect(running).toContain("rebasing…");

    const conflicted = renderToStaticMarkup(
      <RepoMergeStatusStripView
        status={status({ repos: [repo({ hasWork: false }), repo({ name: "svc", path: "/repo/svc", isLeading: false, hasWork: true, ahead: 2, stranded: true })] })}
        onRebaseRepo={() => {}}
        actionState={{ svc: { phase: "done", result: { repo: "svc", success: false, conflictingFiles: ["src/a.ts", "src/b.ts"] } } }}
      />,
    );
    expect(conflicted).toContain("conflicts: src/a.ts, src/b.ts");

    const clean = renderToStaticMarkup(
      <RepoMergeStatusStripView
        status={status({ repos: [repo({ hasWork: false }), repo({ name: "svc", path: "/repo/svc", isLeading: false, hasWork: true, ahead: 2, stranded: true })] })}
        onRebaseRepo={() => {}}
        actionState={{ svc: { phase: "done", result: { repo: "svc", success: true } } }}
      />,
    );
    expect(clean).toContain("rebased ✓");
  });

  it("surfaces a retry-merge error", () => {
    const html = renderToStaticMarkup(
      <RepoMergeStatusStripView
        status={status({ repos: [repo({ hasWork: false }), repo({ name: "svc", path: "/repo/svc", isLeading: false, hasWork: true, ahead: 1, stranded: true })] })}
        onRetryMerge={() => {}}
        retryState={{ phase: "done", error: "Multi-repo merge blocked — nothing was merged." }}
      />,
    );
    expect(html).toContain("retry-merge-error");
    expect(html).toContain("Multi-repo merge blocked");
  });
});
