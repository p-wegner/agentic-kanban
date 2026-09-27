import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MergeActivitySummary, MergeActivityTrain } from "@agentic-kanban/shared/types";
import { DeliveryMergeActivityBody } from "./DeliveryMergeActivity.js";
import { DELIVERY_REFRESH_REASONS } from "../hooks/useDeliveryStatus.js";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function trainRow(overrides: Partial<MergeActivityTrain> = {}): MergeActivityTrain {
  return {
    label: "train/2026-09-27-05", state: "gating", bisecting: false,
    members: [
      { workspaceId: "ws-a", issueNumber: 1253, title: "Fix the gate" },
      { workspaceId: "ws-b", issueNumber: null, title: null },
    ],
    startedAt: ago(12), finishedAt: null, landedCount: null, failureSummary: null,
    ...overrides,
  };
}

function activity(overrides: Partial<MergeActivitySummary> = {}): MergeActivitySummary {
  return { current: null, lastFinished: null, waiting: [], recentWindowMs: 3 * 60 * 60_000, ...overrides };
}

describe("DeliveryMergeActivityBody", () => {
  it("lists the live train's members as #N title rows with state and elapsed time", () => {
    const html = renderToStaticMarkup(<DeliveryMergeActivityBody activity={activity({ current: trainRow() })} nowMs={NOW} />);
    expect(html).toContain("Merging now");
    expect(html).toContain("Merging train-05 · 12m");
    expect(html).toContain("#1253 Fix the gate");
    // A member whose ticket is gone falls back to its short workspace id, not a blank row.
    expect(html).toContain("ws-b");
    expect(html).not.toContain("No train running");
  });

  it("shows the waiting tickets with their wait and the last finished train's outcome and failure", () => {
    const html = renderToStaticMarkup(
      <DeliveryMergeActivityBody
        activity={activity({
          waiting: [{ workspaceId: "ws-w", issueNumber: 1300, title: "Waiting one", readySince: ago(7) }],
          lastFinished: trainRow({ label: "train/2026-09-27-04", state: "red", finishedAt: ago(3), failureSummary: "failing suite(s): a.test.ts" }),
        })}
        nowMs={NOW}
      />,
    );
    expect(html).toContain("No train running.");
    expect(html).toContain("1 ready, waiting");
    expect(html).toContain("#1300 Waiting one");
    expect(html).toContain("7m");
    expect(html).toContain("Last: train-04 red, 3m ago");
    expect(html).toContain("failing suite(s): a.test.ts");
    expect(html).toContain("text-red-600");
  });

  it("the chip refetches on the train and queue events the server broadcasts", () => {
    expect(DELIVERY_REFRESH_REASONS.has("merge_train_changed")).toBe(true);
    expect(DELIVERY_REFRESH_REASONS.has("workspace_ready_for_merge")).toBe(true);
    expect(DELIVERY_REFRESH_REASONS.has("session_activity" as never)).toBe(false);
  });
});
