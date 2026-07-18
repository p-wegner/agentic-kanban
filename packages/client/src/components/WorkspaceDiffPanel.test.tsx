import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceDiffPanel } from "./WorkspaceDiffPanel.js";
import type { DiffResponse } from "@agentic-kanban/shared";

const LEADING_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,2 @@
-const b = 2;
+const b = 99;
`;

const SIBLING_DIFF = `diff --git a/lib/bar.ts b/lib/bar.ts
--- a/lib/bar.ts
+++ b/lib/bar.ts
@@ -1,2 +1,2 @@
-const x = 1;
+const x = 42;
`;

const noop = () => {};

function render(diff: DiffResponse) {
  return renderToStaticMarkup(
    <WorkspaceDiffPanel
      diff={diff}
      diffComments={[]}
      workspaceId="ws1"
      onClose={noop}
      onCommentsChange={noop}
      onError={noop}
    />
  );
}

describe("WorkspaceDiffPanel", () => {
  it("renders the flat diff viewer when repos is absent (single-repo)", () => {
    const html = render({
      diff: LEADING_DIFF,
      stats: { filesChanged: 1, insertions: 1, deletions: 1 },
      comments: [],
    });
    expect(html).toContain("src/foo.ts");
    expect(html).not.toContain("repo-jump-nav");
    expect(html).not.toContain("repo-diff-section-0");
  });

  it("renders per-repo collapsible sections with jump-nav when repos is present", () => {
    const html = render({
      diff: LEADING_DIFF + SIBLING_DIFF,
      stats: { filesChanged: 2, insertions: 2, deletions: 2 },
      comments: [],
      repos: [
        {
          name: null,
          path: "C:\\repos\\backend",
          diff: LEADING_DIFF,
          stats: { filesChanged: 1, insertions: 1, deletions: 1 },
          conflicts: null,
        },
        {
          name: "auth-svc",
          path: "C:\\repos\\auth-svc",
          diff: SIBLING_DIFF,
          stats: { filesChanged: 1, insertions: 1, deletions: 1 },
          conflicts: null,
        },
      ],
    });
    // jump nav lists both repos
    expect(html).toContain("repo-jump-nav");
    // leading repo has no name → falls back to path basename, tagged "leading"
    expect(html).toContain("backend");
    expect(html).toContain("leading");
    expect(html).toContain("auth-svc");
    // one section per repo, each rendering its own diff content
    expect(html).toContain("repo-diff-section-0");
    expect(html).toContain("repo-diff-section-1");
    expect(html).toContain("src/foo.ts");
    expect(html).toContain("lib/bar.ts");
    // header shows "2 repos"
    expect(html).toContain("2 repos");
  });

  it("shows a conflicts badge on a repo section with conflicts", () => {
    const html = render({
      diff: LEADING_DIFF,
      stats: { filesChanged: 1, insertions: 1, deletions: 1 },
      comments: [],
      repos: [
        {
          name: null,
          path: "/repos/backend",
          diff: LEADING_DIFF,
          stats: { filesChanged: 1, insertions: 1, deletions: 1 },
          conflicts: { hasConflicts: true, conflictingFiles: ["src/foo.ts"] },
        },
      ],
    });
    expect(html).toContain("conflicts");
  });

  it("shows an empty note for a repo section with no diff", () => {
    const html = render({
      diff: LEADING_DIFF,
      stats: { filesChanged: 1, insertions: 1, deletions: 1 },
      comments: [],
      repos: [
        {
          name: null,
          path: "/repos/backend",
          diff: LEADING_DIFF,
          stats: { filesChanged: 1, insertions: 1, deletions: 1 },
          conflicts: null,
        },
        {
          name: "notifications-svc",
          path: "/repos/notifications-svc",
          diff: "",
          stats: { filesChanged: 0, insertions: 0, deletions: 0 },
          conflicts: null,
        },
      ],
    });
    expect(html).toContain("No changes in this repo");
  });
});
