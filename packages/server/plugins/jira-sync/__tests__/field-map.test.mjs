import { test } from "node:test";
import assert from "node:assert/strict";
import { mapJiraIssueToBoardFields, mapJiraPriority, resolveBoardStatusId } from "../tools/lib/field-map.mjs";

test("mapJiraIssueToBoardFields: summary -> title, description -> description, priority -> priority, labels -> tags", () => {
  const mapped = mapJiraIssueToBoardFields(
    {
      key: "ENG-1",
      fields: {
        summary: "Set up CI pipeline",
        description: "Wire up a build + test pipeline.",
        status: { name: "To Do", statusCategory: { key: "new" } },
        priority: { name: "High" },
        labels: ["infra", "ci"],
        assignee: { displayName: "Ada Lovelace" },
        updated: "2026-09-01T10:00:00.000+0000",
      },
    },
    { siteUrl: "https://fixture.atlassian.net" },
  );

  assert.equal(mapped.externalKey, "ENG-1");
  assert.equal(mapped.externalUrl, "https://fixture.atlassian.net/browse/ENG-1");
  assert.equal(mapped.title, "Set up CI pipeline");
  assert.equal(mapped.description, "Wire up a build + test pipeline.");
  assert.equal(mapped.priority, "high");
  assert.deepEqual(mapped.tags, ["infra", "ci", "assignee:Ada Lovelace"]);
  assert.equal(mapped.statusCategoryKey, "new");
  assert.equal(mapped.jiraUpdated, "2026-09-01T10:00:00.000+0000");
});

test("mapJiraIssueToBoardFields: no assignee, no labels -> no tags", () => {
  const mapped = mapJiraIssueToBoardFields({ key: "ENG-2", fields: { summary: "x" } });
  assert.deepEqual(mapped.tags, []);
});

test("mapJiraIssueToBoardFields: ADF description is flattened to plain text", () => {
  const mapped = mapJiraIssueToBoardFields({
    key: "ENG-3",
    fields: {
      summary: "x",
      description: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }],
      },
    },
  });
  assert.equal(mapped.description, "Hello world");
});

test("mapJiraIssueToBoardFields: missing description stays null, not an empty string", () => {
  const mapped = mapJiraIssueToBoardFields({ key: "ENG-4", fields: { summary: "x" } });
  assert.equal(mapped.description, null);
});

test("mapJiraPriority: canonical names pass through lowercased", () => {
  assert.equal(mapJiraPriority("High"), "high");
  assert.equal(mapJiraPriority("Critical"), "critical");
});

test("mapJiraPriority: Jira-only spellings fold into the board vocabulary", () => {
  assert.equal(mapJiraPriority("Highest"), "critical");
  assert.equal(mapJiraPriority("Lowest"), "low");
});

test("mapJiraPriority: unknown/absent falls back to medium", () => {
  assert.equal(mapJiraPriority(null), "medium");
  assert.equal(mapJiraPriority("Weird"), "medium");
});

test("resolveBoardStatusId: matches a candidate name for the status category", () => {
  const statuses = [
    { id: "s1", name: "Backlog" },
    { id: "s2", name: "In Progress" },
    { id: "s3", name: "Done", isDefault: true },
  ];
  assert.equal(resolveBoardStatusId("new", statuses), "s1");
  assert.equal(resolveBoardStatusId("indeterminate", statuses), "s2");
  assert.equal(resolveBoardStatusId("done", statuses), "s3");
});

test("resolveBoardStatusId: falls back to the default status when no candidate name exists", () => {
  const statuses = [{ id: "s1", name: "Someone's Custom Column" }, { id: "s2", name: "Also Custom", isDefault: true }];
  assert.equal(resolveBoardStatusId("new", statuses), "s2");
});

test("resolveBoardStatusId: no statuses at all -> null", () => {
  assert.equal(resolveBoardStatusId("new", []), null);
});
