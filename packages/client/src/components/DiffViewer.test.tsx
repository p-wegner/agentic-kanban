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
