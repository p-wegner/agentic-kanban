import { describe, expect, it, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import {
  getButlerPrompt,
  getButlerOverride,
  getGlobalButlerPrompt,
  upsertButlerOverride,
  deleteButlerOverride,
} from "../repositories/agent-skill.repository.js";

// The butler system prompt lives as a special `agent_skills` row named "butler":
// a project-scoped row (projectId set) overrides the global (projectId NULL) one.
// These tests pin that resolution + upsert/delete semantics now that the butler
// route delegates to the repository instead of running inline drizzle.

async function createProject(db: TestDb, name = "Butler Project"): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name,
    repoPath: `C:/tmp/${projectId}`,
    repoName: name.toLowerCase().replace(/\s+/g, "-"),
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return projectId;
}

async function insertGlobalButler(db: TestDb, prompt: string): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(schema.agentSkills).values({
    id: randomUUID(),
    name: "butler",
    projectId: null,
    description: "Global butler",
    prompt,
    isBuiltin: false,
    createdAt: now,
    updatedAt: now,
  });
}

describe("butler-skill repository", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb().db;
  });

  it("getButlerPrompt returns null when neither override nor global exists", async () => {
    const projectId = await createProject(db);
    expect(await getButlerPrompt(projectId, db)).toBeNull();
    expect(await getGlobalButlerPrompt(db)).toBeNull();
    expect(await getButlerOverride(projectId, db)).toBeNull();
  });

  it("getButlerPrompt falls back to the global when no project override exists", async () => {
    const projectId = await createProject(db);
    await insertGlobalButler(db, "GLOBAL");
    expect(await getButlerPrompt(projectId, db)).toBe("GLOBAL");
    expect(await getGlobalButlerPrompt(db)).toBe("GLOBAL");
    expect(await getButlerOverride(projectId, db)).toBeNull();
  });

  it("a project override wins over the global", async () => {
    const projectId = await createProject(db);
    await insertGlobalButler(db, "GLOBAL");
    await upsertButlerOverride(projectId, "OVERRIDE", db);
    expect(await getButlerPrompt(projectId, db)).toBe("OVERRIDE");
    // The global is untouched and still resolvable on its own.
    expect(await getGlobalButlerPrompt(db)).toBe("GLOBAL");
    const override = await getButlerOverride(projectId, db);
    expect(override?.prompt).toBe("OVERRIDE");
  });

  it("upsertButlerOverride updates in place rather than inserting a duplicate", async () => {
    const projectId = await createProject(db);
    await upsertButlerOverride(projectId, "first", db);
    await upsertButlerOverride(projectId, "second", db);
    expect(await getButlerPrompt(projectId, db)).toBe("second");
    const rows = await db.select().from(schema.agentSkills);
    expect(rows.filter((r) => r.name === "butler" && r.projectId === projectId)).toHaveLength(1);
  });

  it("deleteButlerOverride reverts to the global default and is a no-op when absent", async () => {
    const projectId = await createProject(db);
    await insertGlobalButler(db, "GLOBAL");
    await upsertButlerOverride(projectId, "OVERRIDE", db);
    await deleteButlerOverride(projectId, db);
    expect(await getButlerOverride(projectId, db)).toBeNull();
    expect(await getButlerPrompt(projectId, db)).toBe("GLOBAL");
    // Deleting again does not throw.
    await expect(deleteButlerOverride(projectId, db)).resolves.toBeUndefined();
  });

  it("override is scoped per project (one project's override does not leak to another)", async () => {
    const a = await createProject(db, "A");
    const b = await createProject(db, "B");
    await upsertButlerOverride(a, "A-PROMPT", db);
    expect(await getButlerOverride(a, db)).not.toBeNull();
    expect(await getButlerOverride(b, db)).toBeNull();
    expect(await getButlerPrompt(b, db)).toBeNull();
  });
});
