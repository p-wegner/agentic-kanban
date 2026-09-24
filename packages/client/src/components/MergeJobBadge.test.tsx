import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MergeJobBadgeView } from "./MergeJobBadge.js";
import { MergeErrorPanel } from "./MergeErrorPanel.js";
import { describeMergeJobBadge, type MergeStatusView } from "../lib/mergeJobBadge.js";

// No DOM environment in this package (cf. Badge.test.tsx): the views are rendered with
// react-dom/server from a fixture job, which is what "the card renders the badge from a job"
// means here — the store-backed `MergeJobBadge` is one hook call on top of `MergeJobBadgeView`.

const NOW = Date.parse("2026-09-24T12:10:00.000Z");
const status: MergeStatusView = {
  job: {
    jobId: "job-1",
    state: "running",
    startedAt: new Date(NOW - 400_000).toISOString(),
    attempts: [{ attempt: 1, source: "pre-lock-merge", startedAt: new Date(NOW - 390_000).toISOString(), phase: "verify", phaseSince: new Date(NOW - 192_000).toISOString(), phaseDetail: "test:mine, 3 file(s)" }],
  },
  attemptSummary: "1 gate attempt(s). attempt 1 (pre-lock-merge): IN FLIGHT",
};

describe("MergeJobBadgeView (#1250)", () => {
  it("renders the phase, elapsed and attempt with the detail as tooltip", () => {
    const html = renderToStaticMarkup(<MergeJobBadgeView badge={describeMergeJobBadge(status, NOW)!} />);
    expect(html).toContain("Merging · verify · 3m · attempt 1");
    expect(html).toContain('title="test:mine, 3 file(s)');
    expect(html).toContain("animate-pulse");
  });
});

describe("MergeErrorPanel", () => {
  const base = { wsId: "ws-1", actionLoading: false, onFixAndMerge: vi.fn(), mergeHandlers: {} };

  it("offers Bank shrinks and retry beside Fix & Merge when the failure carries a bank-shrinks hint", () => {
    const html = renderToStaticMarkup(
      <MergeErrorPanel
        {...base}
        mergeError={{
          wsId: "ws-1",
          message: "FAIL nloc\nstale baseline: lower a.tsx::A 416 -> 371 in packages/client/src/__tests__/function-nloc-baseline.ts",
          fixHint: { kind: "bank-shrinks", summary: "stale baseline: lower a.tsx::A 416 -> 371 in packages/client/src/__tests__/function-nloc-baseline.ts", edits: [{ baselineFile: "packages/client/src/__tests__/function-nloc-baseline.ts", key: "a.tsx::A", from: 416, to: 371 }] },
        }}
      />,
    );
    expect(html).toContain("Bank shrinks and retry");
    expect(html).toContain("Fix &amp; Merge with AI");
    expect(html).toContain("a.tsx::A: 416 → 371");
    expect(html).toContain("stale baseline");
  });

  it("keeps the plain Fix & Merge banner for any other red", () => {
    const html = renderToStaticMarkup(<MergeErrorPanel {...base} mergeError={{ wsId: "ws-1", message: "verify exited 1", fixHint: null }} />);
    expect(html).not.toContain("Bank shrinks and retry");
    expect(html).toContain("Merge failed -- AI can fix and retry");
    expect(html).toContain("verify exited 1");
  });
});
