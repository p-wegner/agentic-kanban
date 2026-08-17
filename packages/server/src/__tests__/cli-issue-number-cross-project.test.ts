// @covers cli.issueNumber.crossProject [boundary, error-handling]
//
// #467: issue numbers are PER PROJECT, so the same number exists in several projects at once.
// A CLI command run against the active project used to answer a number belonging to another
// project with a bare "not found", which reads as "that ticket does not exist" — and CLAUDE.md
// tells every agent that `#N` is always a kanban issue number, so the denial sends them off
// investigating a phantom. Real instance: `workspace resume 462` denied a ticket that was open
// the whole time, because the CLI's active project was a different one.

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { eq } from "drizzle-orm";
import {
  findProjectsWithIssueNumber,
  getIssueTitleDescriptionByNumber,
  getIssueByNumberOrId,
} from "../repositories/issue/cli-commands.repository.js";

let db: TestDb;
let dispose: () => void;
let alphaId: string;
let betaId: string;

async function seedProject(name: string): Promise<{ projectId: string; statusId: string }> {
  const projectId = randomUUID();
  const statusId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name,
    repoPath: `C:/tmp/${name}`,
    defaultBranch: "main",
  });
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "Backlog",
    sortOrder: 0,
    isDefault: true,
  });
  return { projectId, statusId };
}

async function seedIssue(projectId: string, statusId: string, issueNumber: number, title: string) {
  await db.insert(schema.issues).values({ id: randomUUID(), projectId, statusId, issueNumber, title });
}

beforeEach(async () => {
  const created = createTestDb();
  db = created.db;
  dispose = created.dispose;
  const alpha = await seedProject("alpha");
  const beta = await seedProject("beta");
  alphaId = alpha.projectId;
  betaId = beta.projectId;
  // The overlapping numbering that makes this ambiguous: #7 exists in BOTH projects, #42 only
  // in beta. A per-project lookup in alpha finds the first and misses the second.
  await seedIssue(alphaId, alpha.statusId, 7, "alpha seven");
  await seedIssue(betaId, beta.statusId, 7, "beta seven");
  await seedIssue(betaId, beta.statusId, 42, "beta forty-two");
});

afterEach(() => dispose());

describe("findProjectsWithIssueNumber (#467)", () => {
  it("names the OTHER project holding a number the active one lacks", async () => {
    const owners = await findProjectsWithIssueNumber(42, db);
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ projectId: betaId, projectName: "beta", title: "beta forty-two" });
    // The point of the ticket: from alpha's perspective this is not "no such issue".
    expect(owners.some((o) => o.projectId === alphaId)).toBe(false);
  });

  it("returns every owner when the number is genuinely ambiguous", async () => {
    const owners = await findProjectsWithIssueNumber(7, db);
    expect(owners.map((o) => o.projectName).sort()).toEqual(["alpha", "beta"]);
  });

  it("returns nothing for a number that exists in no project", async () => {
    // This is the only case where a plain "not found" is the honest answer.
    expect(await findProjectsWithIssueNumber(999, db)).toEqual([]);
  });
});

describe("getIssueTitleDescriptionByNumber is project-scoped (#509)", () => {
  it("returns the ACTIVE project's issue, not another project's same number", async () => {
    // Unscoped, this returned whichever row the driver happened to hand back first —
    // and `session find-similar` then fed that text to the failure-pattern search as if
    // it were this ticket's. Same defect class as #506, in a fourth place.
    const alphaRow = await getIssueTitleDescriptionByNumber(7, alphaId, db);
    expect(alphaRow?.title).toBe("alpha seven");

    const betaRow = await getIssueTitleDescriptionByNumber(7, betaId, db);
    expect(betaRow?.title).toBe("beta seven");
  });

  it("misses a number that belongs to another project", async () => {
    // #42 is beta's. From alpha, the honest answer is null — which is what lets the
    // caller reach describeIssueNumberMiss and name beta.
    expect(await getIssueTitleDescriptionByNumber(42, alphaId, db)).toBeNull();
    expect((await getIssueTitleDescriptionByNumber(42, betaId, db))?.title).toBe("beta forty-two");
  });
});

describe("getIssueByNumberOrId refuses a numeric ref with no project (#509)", () => {
  it("returns null instead of comparing project_id against undefined", async () => {
    // Was `eq(issues.projectId, projectId!)` — an assertion, not a check. A numeric ref
    // is meaningless without a project, so the miss is the answer.
    expect(await getIssueByNumberOrId("7", undefined, db)).toBeNull();
  });

  it("still resolves a UUID ref with no project, which is unambiguous on its own", async () => {
    const [row] = await db.select().from(schema.issues).where(eq(schema.issues.projectId, betaId)).limit(1);
    expect(await getIssueByNumberOrId(row.id, undefined, db)).toMatchObject({ id: row.id });
  });
});
