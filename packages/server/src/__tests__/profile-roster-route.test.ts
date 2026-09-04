/**
 * `GET /api/profile-roster` (#1028) and the roster narrowing WRITE guard.
 *
 * The route reads real profile carriers off disk, so this asserts the CONTRACT — the payload
 * parses through the route's own strict zod schema, the project half appears only for a real
 * project, and a quota source that throws degrades instead of failing the request — rather
 * than asserting a particular machine's profile list, which would make the suite depend on
 * whoever's laptop it runs on.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@agentic-kanban/shared/schema";
import { createRoutes } from "../routes/index.js";
import { createTestApp as createHarness } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import type { TestDb } from "./helpers/test-db.js";
import { setQuotaUsageProvider } from "../services/quota-usage.service.js";
import { resetObservedGlobalRosterCache } from "../services/profile-roster.service.js";
import { findRosterWidenings } from "../services/profile-roster-narrowing.service.js";
import { rosterPrefKey, type RosterEntry } from "@agentic-kanban/shared/lib/profile-allowlist";

function createTestApp() {
  return createHarness((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

async function seedProject(db: TestDb, name = "roster-route-project") {
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name, repoPath: `/tmp/${name}`, repoName: name, defaultBranch: "main",
  });
  return projectId;
}

/** A quota source that answers nothing — the common case on a machine with no OAuth login. */
function emptyQuota() {
  setQuotaUsageProvider({ fetchUsage: async () => ({ providers: [], scrapedAt: new Date().toISOString() }) });
}

afterEach(() => {
  resetObservedGlobalRosterCache();
});

describe("GET /api/profile-roster", () => {
  it("answers the roster read model, and the payload survives the strict response schema", async () => {
    emptyQuota();
    const { app } = createTestApp();

    const res = await app.request("/api/profile-roster");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    // The route parses through `profileRosterResponseSchema` before answering, so a 200 IS
    // the schema assertion. These pin the fields a caller branches on.
    expect(Array.isArray(body.profiles)).toBe(true);
    expect(body.project).toBeNull();
    expect(typeof body.roleHintCommand).toBe("string");
    expect(body.roleHintCommand).toContain("claude-pick");
    expect(typeof body.generatedAt).toBe("string");
  });

  it("degrades rather than failing when the quota source throws", async () => {
    setQuotaUsageProvider({ fetchUsage: async () => { throw new Error("no oauth token"); } });
    const { app } = createTestApp();

    const res = await app.request("/api/profile-roster");
    // Roles, conflicts and cooldowns do not depend on quota, so losing the numbers must not
    // lose the table — that is the whole reason `quotaError` is a field and not a status.
    expect(res.status).toBe(200);
    const body = await res.json() as { quotaError: string | null; profiles: unknown[] };
    expect(body.quotaError).toContain("no oauth token");
    expect(Array.isArray(body.profiles)).toBe(true);
  });

  it("includes the project half for a real project, and omits it for an unknown id", async () => {
    emptyQuota();
    const { app, db } = createTestApp();
    const projectId = await seedProject(db);

    const res = await app.request(`/api/profile-roster?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { project: { projectId: string; restricted: boolean; exhaustedPct: number; selection: { poolOrder: string[] } } | null };
    expect(body.project?.projectId).toBe(projectId);
    // No roster stored => unrestricted, which is every project by default (#1025).
    expect(body.project?.restricted).toBe(false);
    expect(body.project?.exhaustedPct).toBe(90);
    expect(Array.isArray(body.project?.selection.poolOrder)).toBe(true);

    const missing = await app.request(`/api/profile-roster?projectId=${randomUUID()}`);
    expect(missing.status).toBe(200);
    expect((await missing.json() as { project: unknown }).project).toBeNull();
  });
});

describe("roster narrowing guard on PUT /api/preferences/settings", () => {
  const globalRoster: RosterEntry[] = [
    { provider: "claude", name: "training", role: "forbidden", dedicatedProject: null },
    { provider: "claude", name: "privat", role: "reserve", dedicatedProject: null },
    { provider: "claude", name: "anth", role: "pool", dedicatedProject: null },
  ];

  it("reports a widening for a role above what the account declares", () => {
    const key = rosterPrefKey("p1");
    const violations = findRosterWidenings({
      patch: { [key]: JSON.stringify([{ provider: "claude", name: "training", role: "pool" }]) },
      globalRoster,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ profileId: "claude:training", requested: "pool", observed: "forbidden" });
  });

  it("allows narrowing, and an equal role, and ignores patches with no roster key", () => {
    const key = rosterPrefKey("p1");
    const narrowing = JSON.stringify([
      { provider: "claude", name: "anth", role: "reserve" },      // pool -> reserve
      { provider: "claude", name: "privat", role: "forbidden" },  // reserve -> forbidden
      { provider: "claude", name: "training", role: "forbidden" },// unchanged
    ]);
    expect(findRosterWidenings({ patch: { [key]: narrowing }, globalRoster })).toEqual([]);
    // A profile the global roster has never heard of has no floor beyond `pool`.
    expect(findRosterWidenings({
      patch: { [key]: JSON.stringify([{ provider: "codex", name: "unseen", role: "pool" }]) },
      globalRoster,
    })).toEqual([]);
    // The common path: no roster key at all, so nothing is even read.
    expect(findRosterWidenings({ patch: { auto_monitor: "true" }, globalRoster })).toEqual([]);
  });

  it("does not stand in the way of an ordinary roster write", async () => {
    emptyQuota();
    const { app, db } = createTestApp();
    const projectId = await seedProject(db, "roster-write-project");
    const key = rosterPrefKey(projectId);

    // All-`pool` is never a widening (`pool` is the floor every account starts from), so
    // this must go through. The guard's worst failure would be refusing writes it should
    // allow, and that is what this pins. The REJECTION half is unit-tested above rather
    // than end to end, because the observed global roster is read from the profile carriers
    // on the machine running the suite — a `forbidden` account cannot be arranged there.
    const res = await app.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: JSON.stringify([{ provider: "claude", name: "anth", role: "pool" }]) }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });
});
