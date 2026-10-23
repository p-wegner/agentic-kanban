import { describe, expect, it } from "vitest";
import { invalidSyncConfigValues } from "../services/plugin-sync.service.js";

const fields = [
  { key: "syncDirection", type: "select", options: ["both", "jira-to-board", "board-to-jira"] },
  { key: "fieldDirections", type: "json" },
];

describe("invalidSyncConfigValues (#1696)", () => {
  it("rejects a direction outside the allowed values and names them", () => {
    const out = invalidSyncConfigValues(fields, { syncDirection: "bidirectional" });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("both | jira-to-board | board-to-jira");
  });

  it("rejects an unknown field name and a bad direction in fieldDirections", () => {
    expect(invalidSyncConfigValues(fields, { fieldDirections: '{"prio":"both"}' })[0]).toContain('unknown field "prio"');
    expect(invalidSyncConfigValues(fields, { fieldDirections: '{"title":"sideways"}' })[0]).toContain("not allowed");
  });

  it("accepts empty values, valid directions and aliases", () => {
    expect(invalidSyncConfigValues(fields, {})).toEqual([]);
    expect(invalidSyncConfigValues(fields, { syncDirection: "both", fieldDirections: '{"summary":"jira-to-board","priority":"both"}' })).toEqual([]);
  });
});
