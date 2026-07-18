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
});
