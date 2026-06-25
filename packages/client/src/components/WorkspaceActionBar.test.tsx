import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceActionBar, type WorkspaceActionBarProps } from "./WorkspaceActionBar.js";
import type { WorkspaceResponse } from "@agentic-kanban/shared";

const noop = () => {};

function workspace(overrides: Partial<WorkspaceResponse> = {}): WorkspaceResponse {
  return {
    id: "ws-1",
    issueId: "issue-1",
    branch: "feature/ak-922-blocked-review",
    status: "idle",
    workingDir: "C:/repo/.worktrees/feature",
    baseBranch: "master",
    isDirect: false,
    provider: "claude",
    claudeProfile: "anth",
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
    ...overrides,
  } as WorkspaceResponse;
}

function renderActionBar(props: Partial<WorkspaceActionBarProps> = {}) {
  return renderToStaticMarkup(
    <WorkspaceActionBar
      ws={workspace()}
      sessions={[]}
      selectedWorkspace={null}
      isRunning={false}
      actionLoading={false}
      diff={null}
      diffComments={[]}
      canResume={() => false}
      canRestart={() => false}
      handleResume={noop}
      handleRestart={noop}
      handleViewDiff={noop}
      handleReview={noop}
      handleMerge={noop}
      handleUpdateBase={noop}
      handleOpenTerminal={noop}
      handleOpenEditor={noop}
      copyPreviewUrl={noop}
      handleAutoBisect={noop}
      handleResetWorkspaceToIdle={noop}
      handleCloseWorkspace={noop}
      handleDeleteWorkspace={noop}
      {...props}
    />,
  );
}

describe("WorkspaceActionBar", () => {
  it("shows recovery instead of an enabled Review button for blocked workspaces", () => {
    const html = renderActionBar({ ws: workspace({ status: "blocked" }) });

    expect(html).toContain("Reset to idle");
    expect(html).toContain("Reset this blocked workspace to idle");
    expect(html).not.toContain(">Review</button>");
    expect(html).not.toContain("Trigger AI code review");
  });
});
