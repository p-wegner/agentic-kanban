import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import { BoardToolbar, formatBoardActivitySummary } from "./BoardToolbar.js";
import type { ViewMode } from "../lib/viewRegistry.js";

function column(name: string, count: number): StatusWithIssues {
  return {
    id: name.toLowerCase().replace(/\s+/g, "-"),
    projectId: "project-1",
    name,
    sortOrder: 0,
    count,
    issues: Array.from({ length: count }, (_, index) => ({ id: `${name}-${index}` }) as any),
  } as StatusWithIssues;
}

describe("formatBoardActivitySummary", () => {
  it("formats non-empty active counts with active work first", () => {
    expect(formatBoardActivitySummary([
      column("Todo", 2),
      column("In Progress", 3),
      column("In Review", 2),
    ])).toBe("3 In Progress, 2 In Review, 2 Todo");
  });

  it("omits empty statuses", () => {
    expect(formatBoardActivitySummary([
      column("Todo", 0),
      column("In Progress", 1),
      column("In Review", 0),
    ])).toBe("1 In Progress");
  });
});

// There is no @testing-library/react in this package, so this is a static-markup
// assertion (the repo convention — cf. ButlerQuestionCard.test.tsx): it proves the
// Merge Queue trigger is actually rendered, not just accepted as a prop (#1200 — it was
// destructured as `_onShowMergeQueue`/`_mergeQueueCount` and never rendered, so the panel
// was unreachable from the toolbar despite the plumbing being complete everywhere else).
function requiredToolbarProps() {
  return {
    activeColumns: [] as StatusWithIssues[],
    onShowQuickTasks: () => {},
    autoMonitor: false,
    monitorRunning: false,
    onMonitorRunNow: async () => {},
    monitorStatus: null,
    onToggleAutoMonitor: () => {},
    autoMonitorInterval: "15",
    onIntervalChange: () => {},
    nudgeAutoStart: false,
    onNudgeAutoStartChange: () => {},
    columns: [] as StatusWithIssues[],
    onOpenWorkspace: () => {},
    viewMode: "kanban" as ViewMode,
    onViewModeChange: () => {},
    projectId: "project-1",
  };
}

// `PluginViewsTab` calls `useQuery` (via `usePluginDocs`), which throws without a
// QueryClientProvider — wrap every render in one, as BacklogMarkdownModal.test.tsx does.
function renderToolbar(props: Partial<ComponentProps<typeof BoardToolbar>> = {}) {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <BoardToolbar {...requiredToolbarProps()} {...props} />
    </QueryClientProvider>,
  );
}

describe("BoardToolbar — Merge Queue trigger", () => {
  it("renders a button with the badge count when the prop is provided", () => {
    const html = renderToolbar({ onShowMergeQueue: () => {}, mergeQueueCount: 3 });
    expect(html).toContain("Merge Queue");
    expect(html).toContain(">3<");
  });

  it("renders no badge when the merge queue is empty", () => {
    const html = renderToolbar({ onShowMergeQueue: () => {}, mergeQueueCount: 0 });
    expect(html).toContain("Merge Queue");
    expect(html).not.toContain("in merge queue");
  });

  it("renders no trigger at all when onShowMergeQueue is not provided", () => {
    const html = renderToolbar();
    expect(html).not.toContain("Merge Queue");
  });
});
