import { describe, expect, it } from "vitest";
import {
  buildDepartureBoardRow,
  buildHistoryStrip,
  formatCountdown,
  holdReasonLabel,
  type DepartureBoardWindowDto,
  type MergeTrainRowDto,
} from "./departureBoard.js";

function window(overrides: Partial<DepartureBoardWindowDto>): DepartureBoardWindowDto {
  return {
    projectId: "project-1",
    pending: [],
    firstSeenAt: new Date().toISOString(),
    config: { maxSize: 5, maxWaitMs: 10 * 60 * 1000, fromPosture: false, postureLevel: "iterate" },
    lastVerdict: { release: false, reason: "accumulating" },
    lastEvaluatedAt: new Date().toISOString(),
    projectedDepartureAt: null,
    heldUntil: null,
    releaseRequestedAt: null,
    liveTrainId: null,
    ...overrides,
  };
}

function member(overrides: Partial<DepartureBoardWindowDto["pending"][number]>) {
  return {
    workspaceId: "ws-1",
    issueNumber: 42,
    issueTitle: "Some ticket",
    readySince: new Date().toISOString(),
    ...overrides,
  };
}

function train(overrides: Partial<MergeTrainRowDto>): MergeTrainRowDto {
  return {
    id: "train-1",
    projectId: "project-1",
    label: "q123",
    memberWorkspaceIds: "[]",
    state: "landed",
    gateEvidence: null,
    bisectResult: null,
    reconciledReason: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("buildDepartureBoardRow", () => {
  it("reports no boarding, no hold reason, and no trigger for an empty window", () => {
    const row = buildDepartureBoardRow(window({}), 1_000_000);
    expect(row.boarding).toEqual([]);
    expect(row.holdReason).toBeNull();
    expect(row.trigger).toBeNull();
    expect(row.msUntilDeparture).toBeNull();
    expect(row.atMaxSize).toBe(false);
  });

  it("triggers on max_size when boarding count reaches the configured max", () => {
    const now = 1_000_000;
    const row = buildDepartureBoardRow(
      window({
        config: { maxSize: 2, maxWaitMs: 10 * 60 * 1000, fromPosture: false, postureLevel: "iterate" },
        pending: [member({ workspaceId: "ws-1" }), member({ workspaceId: "ws-2" })],
        lastVerdict: { release: false, reason: "accumulating" },
      }),
      now,
    );
    expect(row.atMaxSize).toBe(true);
    expect(row.trigger).toBe("max_size");
    expect(row.msUntilDeparture).toBe(0);
  });

  it("triggers on max_wait counting down from firstSeenAt + maxWaitMs", () => {
    const now = 1_000_000;
    const firstSeenAt = new Date(now - 60_000).toISOString();
    const row = buildDepartureBoardRow(
      window({
        config: { maxSize: 10, maxWaitMs: 5 * 60 * 1000, fromPosture: false, postureLevel: "iterate" },
        firstSeenAt,
        pending: [member({})],
        lastVerdict: { release: false, reason: "accumulating" },
      }),
      now,
    );
    expect(row.trigger).toBe("max_wait");
    expect(row.msUntilDeparture).toBe(4 * 60 * 1000);
  });

  it("clamps an overdue max_wait countdown to zero rather than going negative", () => {
    const now = 1_000_000;
    const firstSeenAt = new Date(now - 10 * 60 * 1000).toISOString();
    const row = buildDepartureBoardRow(
      window({
        config: { maxSize: 5, maxWaitMs: 5 * 60 * 1000, fromPosture: false, postureLevel: "iterate" },
        firstSeenAt,
        pending: [member({})],
      }),
      now,
    );
    expect(row.msUntilDeparture).toBe(0);
  });

  it("prefers max_size over max_wait when both would fire", () => {
    const now = 1_000_000;
    const firstSeenAt = new Date(now - 60_000).toISOString();
    const row = buildDepartureBoardRow(
      window({
        config: { maxSize: 1, maxWaitMs: 5 * 60 * 1000, fromPosture: false, postureLevel: "iterate" },
        firstSeenAt,
        pending: [member({})],
      }),
      now,
    );
    expect(row.trigger).toBe("max_size");
  });

  it("suppresses the hold reason when nothing is boarding", () => {
    const row = buildDepartureBoardRow(window({ lastVerdict: { release: false, reason: "gate_busy" }, pending: [] }));
    expect(row.holdReason).toBeNull();
  });

  it("resolves the live train from the trains list via liveTrainId", () => {
    const liveRow = train({ id: "t1", label: "q1", state: "gating", gateEvidence: JSON.stringify({ gateRuns: 2 }), memberWorkspaceIds: JSON.stringify(["ws-1", "ws-2", "ws-3"]) });
    const row = buildDepartureBoardRow(
      window({ liveTrainId: "t1", lastVerdict: { release: false, reason: "live_train" }, pending: [member({})] }),
      Date.now(),
      [liveRow],
    );
    expect(row.liveTrain).toEqual({ id: "t1", label: "q1", state: "gating", memberCount: 3, gateRuns: 2, startedAt: liveRow.startedAt });
    expect(row.holdReason).toBe("live_train");
  });

  it("reports no live train when liveTrainId does not match any fetched train", () => {
    const row = buildDepartureBoardRow(window({ liveTrainId: "missing", pending: [member({})] }), Date.now(), []);
    expect(row.liveTrain).toBeNull();
  });
});

describe("formatCountdown", () => {
  it("formats null as an em dash", () => {
    expect(formatCountdown(null)).toBe("—");
  });

  it("formats zero or negative as departing", () => {
    expect(formatCountdown(0)).toBe("departing");
    expect(formatCountdown(-500)).toBe("departing");
  });

  it("formats sub-minute durations as seconds", () => {
    expect(formatCountdown(45_000)).toBe("45s");
  });

  it("formats minute-scale durations as minutes and seconds", () => {
    expect(formatCountdown(134_000)).toBe("2m 14s");
  });
});

describe("holdReasonLabel", () => {
  it("labels accumulating and gate_busy directly", () => {
    expect(holdReasonLabel("accumulating", null)).toBe("accumulating");
    expect(holdReasonLabel("gate_busy", null)).toBe("gate_busy grace");
  });

  it("labels live_train with the live train's details", () => {
    const liveTrain = { id: "t1", label: "q9", state: "landing" as const, memberCount: 4, gateRuns: 3, startedAt: "2026-09-17T12:00:00.000Z" };
    expect(holdReasonLabel("live_train", liveTrain)).toBe("a train is live (q9, landing, since 2026-09-17T12:00:00.000Z)");
  });

  it("labels null as an em dash", () => {
    expect(holdReasonLabel(null, null)).toBe("—");
  });
});

describe("buildHistoryStrip", () => {
  it("keeps only terminal trains, newest first, capped at 10", () => {
    const rows: MergeTrainRowDto[] = [];
    for (let i = 0; i < 12; i++) {
      rows.push(train({
        id: `t${i}`,
        state: "landed",
        startedAt: new Date(1_000_000 + i * 1000).toISOString(),
      }));
    }
    rows.push(train({ id: "live", state: "gating", startedAt: new Date(2_000_000).toISOString() }));

    const strip = buildHistoryStrip(rows);
    expect(strip).toHaveLength(10);
    expect(strip.map((t) => t.id)).not.toContain("live");
    expect(strip[0].id).toBe("t11");
  });

  it("computes member count, gate runs, and duration per tile", () => {
    const row = train({
      id: "t1",
      state: "red",
      memberWorkspaceIds: JSON.stringify(["ws-1", "ws-2"]),
      gateEvidence: JSON.stringify({ gateRuns: 4 }),
      startedAt: new Date(1_000_000).toISOString(),
      finishedAt: new Date(1_000_000 + 90_000).toISOString(),
    });
    const [tile] = buildHistoryStrip([row]);
    expect(tile).toEqual({ id: "t1", state: "red", memberCount: 2, gateRuns: 4, durationMs: 90_000 });
  });

  it("tolerates malformed JSON and a missing finishedAt", () => {
    const row = train({
      id: "t1",
      state: "abandoned",
      memberWorkspaceIds: "not json",
      gateEvidence: "not json",
      finishedAt: null,
    });
    const [tile] = buildHistoryStrip([row]);
    expect(tile.memberCount).toBe(0);
    expect(tile.gateRuns).toBeNull();
    expect(tile.durationMs).toBeNull();
  });
});
