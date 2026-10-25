/**
 * #1710 - heal noise: advisory dedupe/cancel suppression, infra-inconclusive reds, the land-local
 * host vitest cap default.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projects } from "@agentic-kanban/shared/schema";
import { SETTINGS_REGISTRY } from "@agentic-kanban/shared/lib/settings-registry";
import { createTestDb } from "./helpers/test-db.js";
import { initializeProjectStatuses } from "../repositories/issue.repository.js";
import { reconcileDependencyAdvisoryTickets, type AdvisoryBreach } from "../services/dependency-advisory-heal.service.js";
import { isInfraInconclusiveRed, isRuntimeRefusalLog } from "../services/verify-placement.js";

const BREACH: AdvisoryBreach = { ghsa: "GHSA-aaaa-bbbb-cccc", severity: "high", module: "body-parser", patched: "1.20.4" };

describe("advisory heal dedupe (#1710)", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let projectId: string;
  let statusIds: Record<string, string>;
  const scan = async () => ({ ran: true as const, breaches: [BREACH] });
  const sweep = (now?: string) => reconcileDependencyAdvisoryTickets({ projectId, repoPath: "C:/repo", runScan: scan, now }, db);
  const addIssue = (title: string, status: string, statusChangedAt?: string) => db.insert(issues).values({
    id: randomUUID(), issueNumber: Math.floor(Math.random() * 1e6), title, description: null, priority: "medium", issueType: "task",
    skipAutoReview: false, estimate: null, sortOrder: 0, statusId: statusIds[status], projectId,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), statusChangedAt: statusChangedAt ?? new Date().toISOString(),
  });

  beforeEach(async () => {
    ({ db } = createTestDb());
    projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, name: "adv", repoPath: "C:/repo", repoName: "repo", createdAt: new Date().toISOString() });
    statusIds = await initializeProjectStatuses(projectId, new Date().toISOString(), db);
  });

  it("files nothing while an open issue names the GHSA", async () => {
    await addIssue("bump body-parser (GHSA-AAAA-bbbb-cccc)", "Todo");
    const r = await sweep();
    expect(r.created).toEqual([]);
    expect(await db.select().from(issues).where(eq(issues.projectId, projectId))).toHaveLength(1);
  });

  it("files once, and does not re-file after the operator cancelled it", async () => {
    const first = await sweep();
    expect(first.created).toHaveLength(1);
    const [heal] = await db.select().from(issues).where(eq(issues.projectId, projectId));
    await db.update(issues).set({ statusId: statusIds.Cancelled, statusChangedAt: new Date().toISOString() }).where(eq(issues.id, heal!.id));
    const second = await sweep();
    expect(second.created).toEqual([]);
  });

  it("re-files when the cancel is older than the window or the fixed-in changed", async () => {
    await addIssue("heal: high advisory GHSA-aaaa-bbbb-cccc in body-parser (fixed in 1.20.4)", "Cancelled", new Date(Date.now() - 30 * 86_400_000).toISOString());
    expect((await sweep()).created).toHaveLength(1);
    const other = await reconcileDependencyAdvisoryTickets({ projectId, repoPath: "C:/repo", runScan: async () => ({ ran: true, breaches: [{ ...BREACH, ghsa: "GHSA-zzzz-zzzz-zzzz", patched: "2.0.0" }] }) }, db);
    expect(other.created).toHaveLength(1);
  });
});

describe("infra-inconclusive sweep reds (#1710)", () => {
  it("a base-probe red with zero failing suites is inconclusive; one with suites is not", () => {
    expect(isInfraInconclusiveRed("base-probe", { passed: false, failingSuites: [] })).toBe(true);
    expect(isInfraInconclusiveRed("base-probe", { passed: false, failingSuites: ["a.test.ts"] })).toBe(false);
    expect(isInfraInconclusiveRed("train-gate", { passed: false, failingSuites: [] })).toBe(false);
    expect(isInfraInconclusiveRed("rc-sweep", { passed: true })).toBe(false);
  });

  it("recognises an unsupported-runtime refusal", () => {
    expect(isRuntimeRefusalLog("Your node version is not supported by lint:arch")).toBe(true);
    expect(isRuntimeRefusalLog("AssertionError: expected 1 to be 2")).toBe(false);
  });
});

describe("land-local host vitest cap (#1710)", () => {
  it("is a setting that defaults to 4", () => {
    expect(SETTINGS_REGISTRY.land_local_host_max_workers).toEqual({ type: "number", default: "4" });
  });
});
