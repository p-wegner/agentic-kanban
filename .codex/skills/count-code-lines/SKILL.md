---
name: count-code-lines
description: Count productive code lines per package using scc, scoped to actual source directories
---

---
name: count-code-lines
description: Count productive code lines per package using scc, scoped to actual source directories
---

# count-code-lines

Count productive (non-blank, non-comment) code lines across all source packages using `scc`.

## Step 1: Overall summary

Run scc across all package source dirs combined:

```bash
scc packages/client/src packages/server/src packages/shared/src packages/mcp-server/src packages/e2e packages/desktop/src --include-ext ts,tsx,css --no-complexity
```

## Step 2: Per-package breakdown

Run scc on each package individually and collect the Code column from the Total row:

```bash
for pkg in packages/client/src packages/server/src packages/shared/src packages/mcp-server/src packages/e2e packages/desktop/src; do
  echo "=== $pkg ==="
  scc $pkg --include-ext ts,tsx,css --no-complexity 2>&1 | grep -E "TypeScript|CSS|Total"
done
```

## Step 3: Report

Present results as a markdown table with columns: Package, Files, Code Lines, Comments, Blanks, Total Lines.
Include a totals row. Add a one-sentence observation about the distribution (e.g. largest package, test ratio).