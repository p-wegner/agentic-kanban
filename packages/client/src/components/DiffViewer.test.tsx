import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiffViewer } from "./DiffViewer.js";

const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,4 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 99;
 const c = 3;
`;

const STATS = { filesChanged: 1, insertions: 1, deletions: 1 };

describe("DiffViewer", () => {
  it("renders file path and stats summary", () => {
    const html = renderToStaticMarkup(
      <DiffViewer diff={SAMPLE_DIFF} stats={STATS} />
    );
    expect(html).toContain("src/foo.ts");
    expect(html).toContain("1 file");
  });

  it("renders unified view with + and - prefixes by default", () => {
    const html = renderToStaticMarkup(
      <DiffViewer diff={SAMPLE_DIFF} stats={STATS} />
    );
    // unified view shows +/- prefix chars and color classes
    expect(html).toContain("bg-green-50");
    expect(html).toContain("bg-red-50");
    expect(html).toContain("Unified");
    expect(html).toContain("Split");
  });

  it("renders unresolved comment count when comments present", () => {
    const comments = [
      {
        id: "c1",
        workspaceId: "ws1",
        filePath: "src/foo.ts",
        lineNumOld: null,
        lineNumNew: 2,
        side: "new",
        body: "Check this",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        resolvedAt: null,
      },
    ];
    const html = renderToStaticMarkup(
      <DiffViewer diff={SAMPLE_DIFF} stats={STATS} comments={comments as any} />
    );
    expect(html).toContain("unresolved");
  });

  it("shows no changes message for empty diff", () => {
    const html = renderToStaticMarkup(
      <DiffViewer diff="" stats={{ filesChanged: 0, insertions: 0, deletions: 0 }} />
    );
    expect(html).toContain("No changes to show");
  });

  it("collapses unchanged context beyond 3 lines", () => {
    const manyContextLines = [
      " line1", " line2", " line3", " line4", " line5", " line6", " line7",
    ].join("\n");
    const largeDiff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,10 +1,10 @@
 context1
 context2
 context3
 context4
 context5
 context6
 context7
-old
+new
 context8
 context9
`;
    const html = renderToStaticMarkup(
      <DiffViewer diff={largeDiff} stats={STATS} />
    );
    expect(html).toContain("unchanged line");
    // Should NOT render all 7 context lines (only 3+3 kept, 1 collapsed)
    expect(html).not.toContain("context4");
  });

  it("does not collapse when context is within threshold", () => {
    const smallContextDiff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,5 @@
 ctx1
 ctx2
 ctx3
-old
+new
 ctx4
`;
    const html = renderToStaticMarkup(
      <DiffViewer diff={smallContextDiff} stats={STATS} />
    );
    // No collapsed affordance for small context
    expect(html).not.toContain("unchanged line");
  });

  it("renders expand/collapse toggle when multiple files present", () => {
    const multiFileDiff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-old
+new
`;
    const html = renderToStaticMarkup(
      <DiffViewer diff={multiFileDiff} stats={{ filesChanged: 2, insertions: 2, deletions: 2 }} />
    );
    expect(html).toContain("Collapse all");
  });
});
