/**
 * #633 — "Repos touched" could be set at creation and never changed.
 *
 * `ReposTouchedField` rendered in exactly ONE place (`CreateIssuePanel`), and the only write
 * path was `createIssue`'s `reposTouched`. So any issue filed another way had no repo scope
 * and no way to acquire one: on `comet` all nine issues came from plugin loops through
 * `POST /api/issues`, and fixing them would have meant knowing the storage is `repo:<name>`
 * tags and hand-typing those into the Tags dropdown.
 *
 * Since #629 that scope also decides which repos a launch provisions — each one a real
 * worktree and a real dependency install — so an unsettable field is a cost, not just a gap.
 *
 * `setIssueReposTouched` is the write half these tests cover: a SET (deselecting removes),
 * validated against the project's real repos, touching nothing but `repo:` tags.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issueTags, tags, issues, projects, projectStatuses } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { insertProjectRepo } from "../repositories/repo.repository.js";
import { setIssueReposTouched, applyRepoTags, getIssueReposTouched } from "../services/repo-tags.service.js";

let testDb: TestDb;
let db: TestDb["db"];
let projectId: string;
let issueId: string;

async function tagNamesOn(id: string): Promise<string[]> {
  const rows = await db
    .select({ name: tags.name })
    .from(issueTags)
    .innerJoin(tags, eq(issueTags.tagId, tags.id))
    .where(eq(issueTags.issueId, id));
  return rows.map((r) => r.name).sort();
}

async function seedIssue(): Promise<string> {
  const id = randomUUID();
  const [status] = await db.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId)).limit(1);
  await db.insert(issues).values({
    id, projectId, title: "t", statusId: status.id, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), sortOrder: 0,
  } as never);
  return id;
}

beforeEach(async () => {
  testDb = createTestDb();
  db = testDb.db;
  projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "comet", repoPath: "C:/projects/comet/documentation",
    repoName: "documentation", defaultBranch: "main", createdAt: new Date().toISOString(),
  } as never);
  await db.insert(projectStatuses).values({
    id: randomUUID(), projectId, name: "Backlog", position: 0, color: "#888",
  } as never);
  for (const name of ["api", "web", "infra"]) {
    await insertProjectRepo({ projectId, path: `C:/projects/comet/${name}`, name, defaultBranch: "main" }, db);
  }
  issueId = await seedIssue();
});

describe("setIssueReposTouched (#633)", () => {
  it("sets repos on an issue that had none — the plugin-loop-created case", async () => {
    const applied = await setIssueReposTouched(issueId, projectId, ["api"], db);
    expect(applied).toEqual(["api"]);
    expect(await getIssueReposTouched(issueId, db)).toEqual(["api"]);
  });

  it("REMOVES a deselected repo — otherwise the field is a one-way ratchet", async () => {
    await setIssueReposTouched(issueId, projectId, ["api", "web"], db);
    await setIssueReposTouched(issueId, projectId, ["web"], db);
    expect(await getIssueReposTouched(issueId, db)).toEqual(["web"]);
  });

  it("clears every repo when given an empty list", async () => {
    await setIssueReposTouched(issueId, projectId, ["api", "web"], db);
    expect(await setIssueReposTouched(issueId, projectId, [], db)).toEqual([]);
    expect(await getIssueReposTouched(issueId, db)).toEqual([]);
  });

  it("never disturbs an issue's ORDINARY tags", async () => {
    const tagId = randomUUID();
    await db.insert(tags).values({ id: tagId, name: "urgent", color: "#f00", isBuiltin: false, createdAt: new Date().toISOString() } as never);
    await db.insert(issueTags).values({ id: randomUUID(), issueId, tagId } as never);
    await setIssueReposTouched(issueId, projectId, ["api"], db);
    await setIssueReposTouched(issueId, projectId, [], db);
    expect(await tagNamesOn(issueId)).toEqual(["urgent"]);
  });

  it("drops names that are not the project's repos rather than minting a junk scope", async () => {
    // A scope naming a repo that does not exist reads later as "this ticket touches a repo
    // we cannot find", which is worse than no scope at all.
    expect(await setIssueReposTouched(issueId, projectId, ["api", "nope", ""], db)).toEqual(["api"]);
    expect(await getIssueReposTouched(issueId, db)).toEqual(["api"]);
  });

  it("canonicalizes spelling, so the stored tag is stable across clients", async () => {
    expect(await setIssueReposTouched(issueId, projectId, ["API"], db)).toEqual(["api"]);
    expect(await tagNamesOn(issueId)).toEqual(["repo:api"]);
  });

  it("accepts the LEADING repo, not only siblings", async () => {
    expect(await setIssueReposTouched(issueId, projectId, ["documentation"], db)).toEqual(["documentation"]);
  });

  it("de-duplicates, including across spellings", async () => {
    expect(await setIssueReposTouched(issueId, projectId, ["api", "API", "api"], db)).toEqual(["api"]);
    expect(await tagNamesOn(issueId)).toEqual(["repo:api"]);
  });

  it("is idempotent — re-setting the same repos changes nothing", async () => {
    await setIssueReposTouched(issueId, projectId, ["api", "web"], db);
    const before = await tagNamesOn(issueId);
    await setIssueReposTouched(issueId, projectId, ["api", "web"], db);
    expect(await tagNamesOn(issueId)).toEqual(before);
  });

  it("unlinks the repo tag from THIS issue only — repo tags are global rows", async () => {
    const other = await seedIssue();
    await applyRepoTags(other, ["api"], db);
    await setIssueReposTouched(issueId, projectId, ["api"], db);

    await setIssueReposTouched(issueId, projectId, [], db);

    expect(await getIssueReposTouched(issueId, db)).toEqual([]);
    expect(await getIssueReposTouched(other, db)).toEqual(["api"]);
  });
});
