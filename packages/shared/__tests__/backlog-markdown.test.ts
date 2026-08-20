import { describe, it, expect } from "vitest";
import {
  parseBacklogMarkdown, renderBacklogMarkdown, splitNumberFromTitle, canonicalStatusName,
  normalizePriority, normalizeIssueType, type BacklogMdIssue,
} from "../src/lib/backlog-markdown.js";

const issue = (o: Partial<BacklogMdIssue>): BacklogMdIssue => ({
  number: null, title: "", description: "", status: null, priority: null, issueType: null, tags: [], milestone: null,
  estimate: null, dueDate: null, externalKey: null, externalUrl: null, dependsOn: [], blocks: [], checklist: [], doneMark: false,
  createdAt: null, updatedAt: null, line: 0, ...o,
});

describe("backlog markdown — the standard round-trips", () => {
  it("render → parse preserves every persisted field", () => {
    const src: BacklogMdIssue[] = [
      issue({ number: 12, title: "refactor: collapse the ladders", status: "Backlog", priority: "high", issueType: "chore",
        tags: ["arch", "client"], milestone: "M2", estimate: "3d", dueDate: "2026-09-01", dependsOn: [10, 11], blocks: [13],
        externalKey: "gh-77", externalUrl: "https://example.test/77", createdAt: "2026-08-01T10:00:00Z", updatedAt: "2026-08-02T10:00:00Z",
        description: "Why: nine copies.\n\n## Not a section\nsteps:\n1. one\n2. two",
        checklist: [{ text: "write the table", done: true }, { text: "delete copies", done: false }] }),
      issue({ number: 13, title: "Ship it", status: "In Progress", priority: "medium", issueType: "feature", description: "" }),
      issue({ number: 14, title: "Done thing", status: "Done", priority: "low", issueType: "bug" }),
    ];
    const md = renderBacklogMarkdown(src, { project: "demo", exportedAt: "2026-08-17T00:00:00Z", statuses: ["Backlog", "In Progress", "In Review", "Done"] });
    expect(md).toContain("kanban-md: 1");
    expect(md).toContain("## In Review");             // declared empty section still rendered
    const doc = parseBacklogMarkdown(md);
    expect(doc.format).toBe("kanban-md");
    expect(doc.project).toBe("demo");
    expect(doc.statuses).toEqual(["Backlog", "In Progress", "In Review", "Done"]);
    expect(doc.issues).toHaveLength(3);
    const a = doc.issues[0];
    expect(a).toMatchObject({ number: 12, title: "refactor: collapse the ladders", status: "Backlog", priority: "high", issueType: "chore",
      tags: ["arch", "client"], milestone: "M2", estimate: "3d", dueDate: "2026-09-01", dependsOn: [10, 11], blocks: [13],
      externalKey: "gh-77", externalUrl: "https://example.test/77", createdAt: "2026-08-01", updatedAt: "2026-08-02" });
    expect(a.checklist).toEqual([{ text: "write the table", done: true }, { text: "delete copies", done: false }]);
    expect(a.description).toContain("Why: nine copies.");
    expect(a.description).toContain("#### Not a section");   // demoted so it can't be mistaken for a section
    expect(a.description).toContain("1. one");
    expect(doc.issues[1].status).toBe("In Progress");
    expect(doc.issues[2].status).toBe("Done");
    expect(doc.warnings).toEqual([]);
    expect(doc.confidence).toBe(1);
  });

  it("second render of a parsed doc is byte-identical (stable)", () => {
    const md1 = renderBacklogMarkdown([issue({ number: 1, title: "A", status: "Backlog", priority: "high", tags: ["x"], description: "d" })], { project: "p", timestamps: false });
    const md2 = renderBacklogMarkdown(parseBacklogMarkdown(md1).issues, { project: "p", timestamps: false });
    expect(md2).toBe(md1);
  });
});

describe("backlog markdown — liberal parsing of styles people already write", () => {
  it("BACKLOG.md style: ## sections + `- [ ] item` lists with sub-bullets", () => {
    const doc = parseBacklogMarkdown(`# My project backlog

## Todo
- [ ] Add login page — users can't sign in yet
  - priority: high
  - tags: auth, ui
  - depends on #3
- [ ] Refactor OrderService (#7)
  - blocked by #2
- [x] Write README

## Doing
- [ ] **Migrate DB** — move to postgres
  Some more text under it.

## Done
- [x] Setup CI
`);
    expect(doc.format).toBe("liberal");
    expect(doc.project).toBe("My project backlog");
    expect(doc.statuses).toEqual(["Backlog", "In Progress", "Done"]);      // aliases canonicalised
    expect(doc.issues.map((i) => i.title)).toEqual(["Add login page", "Refactor OrderService", "Write README", "Migrate DB", "Setup CI"]);
    const login = doc.issues[0];
    expect(login).toMatchObject({ status: "Backlog", priority: "high", tags: ["auth", "ui"], dependsOn: [3], description: "users can't sign in yet" });
    expect(doc.issues[1]).toMatchObject({ number: 7, dependsOn: [2] });
    expect(doc.issues[2]).toMatchObject({ doneMark: true, status: "Backlog" });   // section wins over the checkbox
    expect(doc.issues[3]).toMatchObject({ status: "In Progress", description: "move to postgres\nSome more text under it." });
    expect(doc.issues[4]).toMatchObject({ status: "Done", doneMark: true });
    expect(doc.confidence).toBe(1);
  });

  it("heading style with **Key:** value lines and inline hints, no sections", () => {
    const doc = parseBacklogMarkdown(`## Fix crash on start [bug] !p1
**Priority:** high · **Labels:** crash, startup
Stack trace attached.

## Nice to have (low)
Type: feature
Would be nice.
`);
    expect(doc.issues).toHaveLength(2);
    expect(doc.issues[0]).toMatchObject({ title: "Fix crash on start", priority: "high", issueType: "bug", tags: ["crash", "startup"], description: "Stack trace attached." });
    expect(doc.issues[1]).toMatchObject({ title: "Nice to have", priority: "low", issueType: "feature", description: "Would be nice." });
  });

  it("checkbox items without sections: [x] means done", () => {
    const doc = parseBacklogMarkdown(`- [x] old thing\n- [ ] new thing\n`);
    expect(doc.issues[0].status).toBe("Done");
    expect(doc.issues[1].status).toBeNull();
  });

  it("code fences inside descriptions do not spawn issues", () => {
    const doc = parseBacklogMarkdown("## Backlog\n### One\n```md\n- [ ] not an issue\n### nor this\n```\n### Two\n");
    expect(doc.issues.map((i) => i.title)).toEqual(["One", "Two"]);
    expect(doc.issues[0].description).toContain("- [ ] not an issue");
  });

  it("reports what it could not place and a low confidence on junk", () => {
    const doc = parseBacklogMarkdown("Just prose.\n\nMore prose without any structure.\n");
    expect(doc.issues).toHaveLength(0);
    expect(doc.warnings.some((w) => /no issues recognised/.test(w))).toBe(true);
  });
});

describe("helpers", () => {
  it("splitNumberFromTitle", () => {
    expect(splitNumberFromTitle("#12 Title")).toEqual({ number: 12, title: "Title" });
    expect(splitNumberFromTitle("Title (#12)")).toEqual({ number: 12, title: "Title" });
    expect(splitNumberFromTitle("12: Title")).toEqual({ number: null, title: "12: Title" });
    expect(splitNumberFromTitle("**Bold** — rest")).toEqual({ number: null, title: "Bold — rest" });
  });
  it("normalisers", () => {
    expect(normalizePriority("P1")).toBe("high"); expect(normalizePriority("urgent")).toBe("critical"); expect(normalizePriority("nope")).toBeNull();
    expect(normalizeIssueType("story")).toBe("feature"); expect(normalizeIssueType("refactor")).toBe("chore");
    expect(canonicalStatusName("To Do (3)")).toBe("Backlog"); expect(canonicalStatusName("Weird Column")).toBe("Weird Column");
  });
});
