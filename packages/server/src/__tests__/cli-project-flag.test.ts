// @covers cli.projectScoping [correctness, boundary]
//
// #389 (the additive slice of #335): `grep '"--project' packages/server/src/cli/commands/…` had
// ZERO hits — there was no way to be explicit about the target project on any CLI write path, so
// every scoped write silently used the implicit global "active project". That is the direct root
// cause of the 2026-08-08 mis-file, where two board bugs were created against the `bookvault`
// fixture project and sat there unactionable until they were moved to the dev board as #209/#210.
//
// Purely additive by construction: the flag WINS, the active-project preference stays the
// fallback, so no existing invocation changes behaviour. (#335's R1+R4 — deriving the project
// from cwd and preferring it over the pref — stays refused: that would silently RETARGET every
// existing invocation, which is a breaking change and must ship as one.)
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const schemaMod = await import("@agentic-kanban/shared/schema");
  const { db } = createTestDb();
  return { db, writeDb: db, rawClient: undefined, rawWriteClient: undefined, schema: schemaMod, withDbRetry: <T>(fn: () => Promise<T>) => fn() };
});

import { preferences, projects } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import { resolveProjectIdArg } from "../cli/shared.js";

async function makeProject(name: string, opts: { archived?: boolean } = {}) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(projects).values({
    id, name, repoPath: `/tmp/${id}`, repoName: "repo", defaultBranch: "main",
    archivedAt: opts.archived ? now : null, createdAt: now, updatedAt: now,
  });
  return id;
}

async function setActive(projectId: string) {
  const now = new Date().toISOString();
  await db.insert(preferences).values({ key: "activeProjectId", value: projectId, updatedAt: now })
    .onConflictDoUpdate({ target: preferences.key, set: { value: projectId, updatedAt: now } });
}

describe("resolveProjectIdArg (#389)", () => {
  it("falls back to the active project when no flag is given — no existing call changes", async () => {
    const active = await makeProject(`active-${randomUUID().slice(0, 8)}`);
    await setActive(active);
    expect(await resolveProjectIdArg(undefined)).toBe(active);
  });

  it("the flag WINS over the active project", async () => {
    const active = await makeProject(`active-${randomUUID().slice(0, 8)}`);
    const other = await makeProject("bookvault-fixture");
    await setActive(active);
    expect(await resolveProjectIdArg("bookvault-fixture")).toBe(other);
  });

  it("accepts a raw project id", async () => {
    const id = await makeProject(`byid-${randomUUID().slice(0, 8)}`);
    expect(await resolveProjectIdArg(id)).toBe(id);
  });

  it("matches case-insensitively when that is unambiguous", async () => {
    const id = await makeProject("Pantry");
    expect(await resolveProjectIdArg("pantry")).toBe(id);
  });

  it("prefers an EXACT name over a case-insensitive one", async () => {
    // Otherwise "Pantry" and "pantry" coexisting would resolve by luck of ordering.
    const exact = await makeProject("Toolbox");
    await makeProject("toolbox");
    expect(await resolveProjectIdArg("Toolbox")).toBe(exact);
  });

  it("refuses an ambiguous name rather than guessing", async () => {
    await makeProject("Twins");
    await makeProject("twins");
    await expect(resolveProjectIdArg("TWINS")).rejects.toThrow(/pass the project id/i);
  });

  it("finds an ARCHIVED project — naming one explicitly is deliberate", async () => {
    // Refusing would be a second confusing "no such project" for a project the user can see.
    const id = await makeProject("retired-thing", { archived: true });
    expect(await resolveProjectIdArg("retired-thing")).toBe(id);
  });

  it("fails loudly, with the command that lists the options", async () => {
    await expect(resolveProjectIdArg("no-such-project-xyz")).rejects.toThrow(/No project named .* list/s);
  });
});
