/**
 * Sync panel (#1630). No @testing-library/react in this package, so static-markup assertions on
 * the pure pieces: the status body the panel renders, the fold that makes a just-triggered run
 * show immediately, and the typed-field validation behind Save.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginSyncRunRecord, PluginSyncStatusView } from "@agentic-kanban/shared";
import { SyncStatusBody, applyTriggeredRun, effectiveCadence } from "./PluginSyncPanel.js";
import { validateSyncField, validateSyncFields } from "./pluginSyncFields.js";

const T0 = Date.now() - 10 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function run(over: Partial<PluginSyncRunRecord> = {}): PluginSyncRunRecord {
  return { direction: "pull", dryRun: false, ok: true, startedAt: iso(T0), finishedAt: iso(T0 + 5_000), ...over };
}

function status(over: Partial<PluginSyncStatusView> = {}): PluginSyncStatusView {
  const scheduled = run({ scheduled: true, summary: { counts: { created: 1 } } });
  return {
    provider: "jira", configured: true, lastRun: scheduled, lastRuns: { pull: scheduled, push: null },
    outboxLength: 0, schedule: { pullEveryMinutes: 1, pushEveryMinutes: 0 }, ...over,
  };
}

describe("PluginSyncPanel", () => {
  it("renders the new manual run after a pull is triggered, not the previous scheduled one", () => {
    const before = status();
    expect(renderToStaticMarkup(<SyncStatusBody status={before} />)).toContain("(scheduled)");

    const manual = run({ startedAt: iso(T0 + 120_000), finishedAt: iso(T0 + 125_000), summary: { counts: { updated: 7 } } });
    const html = renderToStaticMarkup(<SyncStatusBody status={applyTriggeredRun(before, manual)} />);
    expect(html).toContain("7 updated");
    expect(html).not.toContain("(scheduled)");
  });

  it("keeps newer server data over an older folded run", () => {
    const newer = run({ startedAt: iso(T0 + 300_000), finishedAt: iso(T0 + 305_000), scheduled: true });
    const s = status({ lastRuns: { pull: newer, push: null } });
    expect(applyTriggeredRun(s, run()).lastRuns.pull).toBe(newer);
  });

  it("links conflicts and failures to the board issue next to the Jira key", () => {
    const r = run({
      summary: {
        issues: [{ externalKey: "ENG-1", localIssueNumber: 42 }],
        conflicts: [{ externalKey: "ENG-1", reason: "both changed", externalUrl: "https://x/browse/ENG-1" }],
        failures: [{ externalKey: "ENG-2", reason: "boom", localIssueNumber: 43 }],
      },
    });
    const html = renderToStaticMarkup(<SyncStatusBody status={status({ lastRuns: { pull: r, push: null } })} />);
    expect(html).toContain("ENG-1");
    expect(html).toContain('data-testid="plugin-sync-board-issue-42"');
    expect(html).toContain('data-testid="plugin-sync-board-issue-43"');
  });

  it("shows the effective cadence and the next run", () => {
    const html = renderToStaticMarkup(<SyncStatusBody status={status()} />);
    expect(html).toContain("every ~2 min (set 1)");
    expect(html).toContain("next at");
    expect(effectiveCadence(0, null)).toEqual({ label: "off", nextAt: null });
  });
});

describe("sync field validation", () => {
  it("accepts empty values and valid typed values", () => {
    expect(validateSyncField("number", "")).toBeNull();
    expect(validateSyncField("number", "5")).toBeNull();
    expect(validateSyncField("boolean", "true")).toBeNull();
    expect(validateSyncField("json", '{"Done":"Fertig"}')).toBeNull();
    expect(validateSyncField("text", "anything")).toBeNull();
  });

  it("rejects bad numbers, booleans and JSON", () => {
    expect(validateSyncField("number", "abc")).toMatch(/whole number/);
    expect(validateSyncField("number", "-1")).toMatch(/whole number/);
    expect(validateSyncField("boolean", "yes")).toMatch(/true or false/);
    expect(validateSyncField("json", "{nope")).toMatch(/invalid JSON/);
    expect(validateSyncField("json", "[1]")).toMatch(/object/);
  });

  it("collects one error per bad field", () => {
    const errors = validateSyncFields(
      [{ key: "a", type: "number" }, { key: "b", type: "json" }, { key: "c", type: "text" }],
      { a: "x", b: "{}", c: "ok" },
    );
    expect(Object.keys(errors)).toEqual(["a"]);
  });
});
