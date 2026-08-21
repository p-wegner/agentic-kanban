// @covers repos.installState [recovery, boundary]
//
// #685 — a deferred sibling install's `pending`/`running` row has no timeout, no reconciler
// and no re-run path. It is written at create time, long before the background runner would
// ever flip it to `running`/`done`/`failed`, so a blocking-leading-setup failure that skips
// deferred provisioning, a server restart mid-install, or any early return before the runner
// starts all leave the row `pending` forever — the merge gate then refuses the branch on every
// cycle with no way out except hand-editing the DB or recreating the workspace.
//
// The policy under test decides when a `pending`/`running` row has gone stale long enough that
// it must be treated as abandoned rather than "still working".
import { describe, expect, it } from "vitest";
import {
  decideInstallStalenessAction,
  INSTALL_STALE_TIMEOUT_MS,
  type OutstandingRepoInstallRow,
} from "../startup/install-staleness-reconciler.js";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");

function row(overrides: Partial<OutstandingRepoInstallRow> = {}): OutstandingRepoInstallRow {
  return {
    workspaceId: "ws-1",
    path: "/repos/sibling",
    name: "sibling",
    installState: "pending",
    installUpdatedAt: new Date(NOW - 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("decideInstallStalenessAction (#685)", () => {
  it("holds a recently-updated pending/running row — it may genuinely still be installing", () => {
    expect(decideInstallStalenessAction(row(), NOW).action).toBe("hold");
    expect(decideInstallStalenessAction(row({ installState: "running" }), NOW).action).toBe("hold");
  });

  it("fails a row that has not been touched since well before the timeout", () => {
    const stale = row({ installUpdatedAt: new Date(NOW - INSTALL_STALE_TIMEOUT_MS - 60_000).toISOString() });
    expect(decideInstallStalenessAction(stale, NOW).action).toBe("fail");
  });

  it("holds right up to the boundary and fails just past it", () => {
    const justInside = row({ installUpdatedAt: new Date(NOW - INSTALL_STALE_TIMEOUT_MS + 1000).toISOString() });
    expect(decideInstallStalenessAction(justInside, NOW).action).toBe("hold");
    const justOutside = row({ installUpdatedAt: new Date(NOW - INSTALL_STALE_TIMEOUT_MS - 1000).toISOString() });
    expect(decideInstallStalenessAction(justOutside, NOW).action).toBe("fail");
  });

  it("fails rather than holds forever when installUpdatedAt is missing or unparseable", () => {
    // This is the exact defect from #685: a row with no readable timestamp must not become a
    // permanent excuse not to act — the mirror of decideBornBlockedAction's same rule for
    // setupEndedAt.
    expect(decideInstallStalenessAction(row({ installUpdatedAt: null }), NOW).action).toBe("fail");
    expect(decideInstallStalenessAction(row({ installUpdatedAt: "not-a-date" }), NOW).action).toBe("fail");
  });

  it("respects a custom timeout override", () => {
    const fiveMinOld = row({ installUpdatedAt: new Date(NOW - 5 * 60 * 1000).toISOString() });
    expect(decideInstallStalenessAction(fiveMinOld, NOW, 60_000).action).toBe("fail");
    expect(decideInstallStalenessAction(fiveMinOld, NOW, 10 * 60 * 1000).action).toBe("hold");
  });

  it("names its reason, so the sweep log explains every decision", () => {
    const stale = row({ installUpdatedAt: new Date(NOW - INSTALL_STALE_TIMEOUT_MS - 60_000).toISOString() });
    expect(decideInstallStalenessAction(stale, NOW).reason).toContain("abandoned");
  });
});
