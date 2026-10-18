/**
 * #1613 — code-health posture: a soft breach is recorded and never blocks; the Nth soft breach
 * files ONE cleanup ticket and the N+1th appends to it; a started ticket holds new breaches.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, preferences, projects } from "@agentic-kanban/shared/schema";
import type { SoftBreach } from "../lib/code-health.js";
import { createTestDb } from "./helpers/test-db.js";
import { initializeProjectStatuses } from "../repositories/issue.repository.js";
import { invalidatePreferencesCache } from "../repositories/preferences.repository.js";
import { cleanupTicketExternalKey, recordCodeHealth } from "../services/code-health.service.js";
import { getDeliveryStatus } from "../services/delivery-status.service.js";

const breach = (i: number): SoftBreach => ({ file: `packages/x/src/f${i}.ts`, metric: "lines", value: 1100 + i, cap: 1000 });
const scan = (n: number) => Array.from({ length: n }, (_, i) => breach(i));

describe("code-health ledger and cleanup ticket (#1613)", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let projectId: string;
  let statusIds: Record<string, string>;

  async function setPref(key: string, value: string) {
    await db.delete(preferences).where(eq(preferences.key, key));
    await db.insert(preferences).values({ key, value, updatedAt: new Date().toISOString() });
    invalidatePreferencesCache();
  }
  const cleanupRows = () => db.select().from(issues).where(eq(issues.externalKey, cleanupTicketExternalKey(projectId)));

  beforeEach(async () => {
    ({ db } = createTestDb());
    invalidatePreferencesCache();
    projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId, name: "ch", repoPath: "C:/repo", repoName: "repo", createdAt: new Date().toISOString(),
    });
    statusIds = await initializeProjectStatuses(projectId, new Date().toISOString(), db);
    await setPref(`risk_posture_${projectId}`, "sprint"); // -> relaxed: ticket at 10
  });

  it("records soft breaches below the trigger without filing a ticket", async () => {
    const r = await recordCodeHealth({ projectId, breaches: scan(7), ref: "abc123" }, db);
    expect(r.action).toBe("none");
    expect(r.line).toBe("code health: 7 soft breaches in 7 files, cleanup ticket at 10 (relaxed)");
    expect(r.ledger).toHaveLength(7);
    expect(r.ledger[0].crossedBy).toBe("abc123");
    expect(await cleanupRows()).toHaveLength(0);
  });

  it("the 10th breach files ONE ticket, the 11th appends to it", async () => {
    const tenth = await recordCodeHealth({ projectId, breaches: scan(10) }, db);
    expect(tenth.action).toBe("file");
    expect(await cleanupRows()).toHaveLength(1);

    const eleventh = await recordCodeHealth({ projectId, breaches: scan(11) }, db);
    expect(eleventh.action).toBe("append");
    const rows = await cleanupRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toContain("f10.ts");
  });

  it("keeps firstSeen across scans and drops breaches that were fixed", async () => {
    await recordCodeHealth({ projectId, breaches: scan(3), now: "2026-10-01T00:00:00.000Z" }, db);
    const r = await recordCodeHealth({ projectId, breaches: scan(2), now: "2026-10-05T00:00:00.000Z" }, db);
    expect(r.ledger).toHaveLength(2);
    expect(r.ledger[0].firstSeen).toBe("2026-10-01T00:00:00.000Z");
  });

  it("an old breach (14 days under relaxed) makes the ticket due before the count does", async () => {
    await recordCodeHealth({ projectId, breaches: scan(1), now: "2026-10-01T00:00:00.000Z" }, db);
    const r = await recordCodeHealth({ projectId, breaches: scan(1), now: "2026-10-16T00:00:00.000Z" }, db);
    expect(r.action).toBe("file");
  });

  it("a started cleanup ticket HOLDS new breaches instead of growing", async () => {
    await recordCodeHealth({ projectId, breaches: scan(10) }, db);
    const [row] = await cleanupRows();
    await db.update(issues).set({ statusId: statusIds["In Progress"] }).where(eq(issues.id, row.id));
    const r = await recordCodeHealth({ projectId, breaches: scan(12) }, db);
    expect(r.action).toBe("hold");
    expect((await cleanupRows())[0].description).not.toContain("f11.ts");
  });

  it("strict files on any soft breach; the override beats the risk-derived level", async () => {
    await setPref(`code_health_posture_${projectId}`, "strict");
    const r = await recordCodeHealth({ projectId, breaches: scan(1) }, db);
    expect(r.action).toBe("file");
  });

  it("GET delivery shows the resolved code-health posture next to the risk posture", async () => {
    await recordCodeHealth({ projectId, breaches: scan(4) }, db);
    const status = await getDeliveryStatus(projectId, db);
    expect(status.codeHealth).toMatchObject({ level: "relaxed", source: "risk-posture", openSoftBreaches: 4, files: 4 });
    expect(status.codeHealth?.caps.lines).toEqual({ soft: 1000, hard: 1600 });
    expect(status.codeHealth?.line).toBe("code health: 4 soft breaches in 4 files, cleanup ticket at 10 (relaxed)");
  });
});
