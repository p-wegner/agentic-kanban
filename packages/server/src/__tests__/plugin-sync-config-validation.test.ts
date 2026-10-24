import { describe, expect, it } from "vitest";
import { invalidSyncConfigValues } from "../services/plugin-sync.service.js";

const fields = [
  { key: "syncDirection", type: "select", options: ["both", "jira-to-board", "board-to-jira"] },
  { key: "fieldDirections", type: "json" },
  { key: "customFieldMap", type: "json" },
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

  it("checks the assigneeMap shape (#1702)", () => {
    const f = [{ key: "assigneeMap", type: "json" }];
    expect(invalidSyncConfigValues(f, { assigneeMap: '{"acc1":"Peter"}' })).toEqual([]);
    expect(invalidSyncConfigValues(f, { assigneeMap: '[{"accountId":"acc1","name":"Peter"}]' })).toEqual([]);
    expect(invalidSyncConfigValues(f, { assigneeMap: "nope" })[0]).toContain("not valid JSON");
    expect(invalidSyncConfigValues(f, { assigneeMap: '{"acc1":""}' })[0]).toContain("non-empty");
    expect(invalidSyncConfigValues(fields, { fieldDirections: '{"assignee":"both"}' })).toEqual([]);
  });
});

describe("customFieldMap (#1701)", () => {
  it("rejects a non-object and a target without a prefix; accepts field -> tag:<prefix>", () => {
    expect(invalidSyncConfigValues(fields, { customFieldMap: "[1]" })[0]).toContain("JSON object");
    expect(invalidSyncConfigValues(fields, { customFieldMap: '{"Team":"x y"}' })[0]).toContain('"Team"');
    expect(invalidSyncConfigValues(fields, { customFieldMap: '{"Story Points":"tag:sp"}' })).toEqual([]);
  });
});
