import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, projectStatuses, issues, tags, issueTags } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  exportBacklogMarkdown, previewBacklogMarkdownImport, applyBacklogMarkdownImport, resolveStatusName,
} from "../services/backlog-markdown.service.js";
import { parseBacklogMarkdown } from "@agentic-kanban/shared/lib/backlog-markdown";

type Db = ReturnType<typeof createTestDb>["db"];
const STATUS_NAMES = ["Backlog", "In Progress", "In Review", "Done"];

async function seedProject(db: Db, name = "demo") {
  const projectId = randomUUID();
  const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
  await db.insert(projects).values({ id: projectId, name, repoPath: `/tmp/${name}`, repoName: name, createdAt: now, updatedAt: now });
  const statusIds: Record<string, string> = {};
  for (let i = 0; i < STATUS_NAMES.length; i++) {
    const id = randomUUID(); statusIds[STATUS_NAMES[i]] = id;
    await db.insert(projectStatuses).values({ id, projectId, name: STATUS_NAMES[i], sortOrder: i, isDefault: i === 0, createdAt: now });
  }
  const tagId = randomUUID();
  await db.insert(tags).values({ id: tagId, name: "arch", color: null, createdAt: now });
  const i1 = randomUUID(), i2 = randomUUID();
  await db.insert(issues).values([
    { id: i1, issueNumber: 1, title: "Collapse the ladders", description: "nine copies", priority: "high", issueType: "chore", sortOrder: 0, statusId: statusIds["Backlog"], projectId, createdAt: now, updatedAt: now },
    { id: i2, issueNumber: 2, title: "Old done thing", description: null, priority: "low", issueType: "task", sortOrder: 1, statusId: statusIds["Done"], projectId, createdAt: now, updatedAt: now },
  ]);
  await db.insert(issueTags).values({ id: randomUUID(), issueId: i1, tagId });
  return { projectId, statusIds };
}

describe("backlog markdown service", () => {
  it("exports non-terminal issues by default, all with includeDone, and honours filters", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    const open = await exportBacklogMarkdown(projectId, {}, db);
    expect(open.count).toBe(1);
    expect(open.markdown).toContain("### #1 Collapse the ladders");
    expect(open.markdown).toContain("`tags: arch`");
    expect(open.markdown).not.toContain("Old done thing");
    expect(open.markdown).toContain("filter: status=open");
    const all = await exportBacklogMarkdown(projectId, { includeDone: true }, db);
    expect(all.count).toBe(2);
    expect(all.markdown).toContain("## Done");
    const byTag = await exportBacklogMarkdown(projectId, { includeDone: true, tags: ["nope"] }, db);
    expect(byTag.count).toBe(0);
    const bare = await exportBacklogMarkdown(projectId, { bare: true }, db);
    expect(bare.markdown.startsWith("## ")).toBe(true);
    // what we export, we can parse back
    const doc = parseBacklogMarkdown(all.markdown);
    expect(doc.format).toBe("kanban-md");
    expect(doc.project).toBe("demo");
    expect(doc.issues.map((i) => i.number)).toEqual([1, 2]);
  });

  it("resolves section names: exact, alias, unknown → create or map", () => {
    const names = ["Backlog", "In Progress", "Done"];
    expect(resolveStatusName("in progress", names, "Backlog", "create")).toEqual({ name: "In Progress", create: false });
    expect(resolveStatusName("Todo", names, "Backlog", "create")).toEqual({ name: "Backlog", create: false });
    expect(resolveStatusName("Doing", names, "Backlog", "create")).toEqual({ name: "In Progress", create: false });
    expect(resolveStatusName("Waiting for vendor", names, "Backlog", "create")).toEqual({ name: "Waiting for vendor", create: true });
    expect(resolveStatusName("Waiting for vendor", names, "Backlog", "map")).toEqual({ name: "Backlog", create: false });
    expect(resolveStatusName(null, names, "Backlog", "create")).toEqual({ name: "Backlog", create: false });
  });

  it("previews a liberal file: creates, matches by title, plans new columns/tags, then applies and is idempotent", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    const text = `# Someone else's backlog

## Todo
- [ ] Collapse the ladders
  - priority: critical
  - tags: arch, client
- [ ] Brand new item [bug] !p1 — it crashes
  - depends on #1

## Waiting for vendor
- [ ] Vendor thing
`;
    const p = await previewBacklogMarkdownImport(projectId, text, {}, db);
    expect(p.format).toBe("liberal");
    expect(p.sameProject).toBe(false);
    expect(p.counts).toEqual({ create: 2, update: 1, unchanged: 0 });
    const ladders = p.rows.find((r) => r.title === "Collapse the ladders")!;
    expect(ladders.action).toBe("update");
    expect(ladders.matchedBy).toBe("title");
    expect(ladders.changes).toEqual(["priority high → critical", "+tags client"]);
    const brand = p.rows.find((r) => r.title === "Brand new item")!;
    expect(brand).toMatchObject({ action: "create", status: "Backlog", priority: "high", issueType: "bug" });
    expect(p.statusesToCreate).toEqual(["Waiting for vendor"]);
    expect(p.tagsToCreate).toEqual(["client"]);
    expect(p.warnings.some((w) => /refers to #1.*existing/.test(w))).toBe(true);   // dependency target not in the file

    const r = await applyBacklogMarkdownImport(projectId, text, {}, db);
    expect(r.created).toBe(2);
    expect(r.updated).toBe(1);
    expect(r.createdStatuses).toEqual(["Waiting for vendor"]);
    expect(r.createdTags).toContain("client");
    expect(r.createdDependencies).toBe(1);

    // idempotent: the same file again changes nothing
    const again = await previewBacklogMarkdownImport(projectId, text, {}, db);
    expect(again.counts).toEqual({ create: 0, update: 0, unchanged: 3 });

    // and the export now reflects it, round-tripping through the standard
    const exported = await exportBacklogMarkdown(projectId, {}, db);
    expect(exported.markdown).toContain("## Waiting for vendor");
    expect(exported.markdown).toMatch(/### #1 Collapse the ladders\n`priority: critical`/);
    expect(exported.markdown).toMatch(/Brand new item\n`priority: high` · `type: bug` · `depends: #1`/);
    const rt = await previewBacklogMarkdownImport(projectId, exported.markdown, {}, db);
    expect(rt.sameProject).toBe(true);
    expect(rt.rows.every((x) => x.matchedBy === "number")).toBe(true);
    expect(rt.counts.create + rt.counts.update).toBe(0);
  });

  it("mode=create ignores matches and renumbers collisions", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    const r = await applyBacklogMarkdownImport(projectId, "## Backlog\n### #1 Collapse the ladders\n`priority: low`\n", { mode: "create" }, db);
    expect(r.created).toBe(1);
    expect(r.updated).toBe(0);
    expect(r.warnings.some((w) => /Renumbered/.test(w))).toBe(true);
  });
});
