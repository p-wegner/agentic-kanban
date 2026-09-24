/**
 * #1239 — the release-candidate heal ticket: filed per failure signature PER rc by a red rc
 * sweep, forced into the heal workspace's gate, closed by the merge-back landing, and moved to
 * the next candidate when an rc is abandoned. A green MASTER sweep never touches one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, like } from "drizzle-orm";
import { baseBranchHealth, issueComments, issues, issueTags, preferences, projects, tags, workspaces } from "@agentic-kanban/shared/schema";
import { failureSignature } from "../lib/heal-failure-signature.js";
import {
  healTicketExternalKey,
  healTicketKeyScanPrefix,
  mergeBackExternalKey,
  parseHealTicketExternalKey,
  parseMergeBackExternalKey,
  HEAL_TICKET_TAG,
} from "../lib/heal-ticket-key.js";
import { createTestDb } from "./helpers/test-db.js";
import { initializeProjectStatuses } from "../repositories/issue.repository.js";
import { invalidatePreferencesCache } from "../repositories/preferences.repository.js";
import { listOpenHealTickets, reconcileBaseHealthHealTicket } from "../services/base-health-heal-ticket.service.js";
import {
  closeHealTicketsForMergedIssue,
  countInheritedRed,
  listOpenRcHealTickets,
  rcHealSummary,
  reconcileRcSweep,
  reproduceSuiteCommand,
  retargetRcHealTickets,
} from "../services/rc-heal-ticket.service.js";
import { resolveHealForcedSuites } from "../services/heal-gate-forcing.js";
import { resolveImpactSelectorEnv } from "../services/pre-merge-gate-tier.js";

const RC = "rc/20260925";
const RC_NEXT = "rc/20260926";
const RED_SUITES = ["packages/server/src/__tests__/merge-gate.test.ts", "packages/shared/__tests__/git-exec-single-spawn.test.ts"];
const SHA = "cafe9876cafe9876cafe9876cafe9876cafe9876";

describe("heal-ticket key with an rc segment (#1239)", () => {
  it("carries the rc branch, parses back, and a base-lane key still parses with branch null", () => {
    const key = healTicketExternalKey("p1", "abc123", RC);
    expect(key).toBe(`base-health-heal:p1:abc123:${RC}`);
    expect(key.startsWith(healTicketKeyScanPrefix("p1"))).toBe(true);
    expect(parseHealTicketExternalKey(key)).toEqual({ projectId: "p1", signature: "abc123", branch: RC });
    expect(parseHealTicketExternalKey(healTicketExternalKey("p1", "abc123"))).toEqual({ projectId: "p1", signature: "abc123", branch: null });
    expect(parseHealTicketExternalKey("base-health-heal:p1")).toEqual({ projectId: "p1", signature: null, branch: null });
  });

  it("the merge-back key is its own namespace", () => {
    expect(parseMergeBackExternalKey(mergeBackExternalKey("p1", RC))).toEqual({ projectId: "p1", branch: RC });
    expect(parseMergeBackExternalKey(healTicketExternalKey("p1", "x", RC))).toBeNull();
    expect(parseHealTicketExternalKey(mergeBackExternalKey("p1", RC))).toBeNull();
  });

  it("reproduces a vitest suite from its package, and falls back to the verify script", () => {
    expect(reproduceSuiteCommand("packages/server/src/__tests__/merge-gate.test.ts", "pnpm test:mine"))
      .toBe("cd packages/server && pnpm --silent exec vitest run src/__tests__/merge-gate.test.ts --maxWorkers=2");
    expect(reproduceSuiteCommand("src/lib/x.spec.py", "uv run pytest")).toContain("uv run pytest");
  });

  it("inherited red is the overlap with master's failing set, slash-normalised", () => {
    expect(countInheritedRed(RED_SUITES, [RED_SUITES[0].replace(/\//g, "\\"), "other.test.ts"])).toBe(1);
    expect(countInheritedRed(RED_SUITES, null)).toBe(0);
  });
});

describe("rc heal ticket lifecycle (#1239)", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let projectId: string;
  let statusIds: Record<string, string>;
  const tempDirs: string[] = [];

  async function rcSweep(outcome: "red" | "green" | "timeout", rcBranch = RC, failedSuites: string[] | null = RED_SUITES, extra: Record<string, unknown> = {}) {
    return reconcileRcSweep({
      projectId,
      rcBranch,
      sha: SHA,
      outcome,
      failedSuites,
      healthRowId: "rc-row-1",
      message: outcome === "red" ? "2 failed | 781 passed" : undefined,
      lastGreenSha: "beef1234beef1234beef1234beef1234beef1234",
      lastGreenLabel: "master (nightly sweep)",
      verifyScript: "pnpm test:mine",
      ...extra,
    }, db);
  }

  async function healRows() {
    return db.select().from(issues).where(like(issues.externalKey, `${healTicketKeyScanPrefix(projectId)}%`));
  }

  async function tagNames(issueId: string) {
    const linked = await db.select({ name: tags.name }).from(issueTags).innerJoin(tags, eq(issueTags.tagId, tags.id)).where(eq(issueTags.issueId, issueId));
    return linked.map((t) => t.name);
  }

  beforeEach(async () => {
    ({ db } = createTestDb());
    invalidatePreferencesCache();
    projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, name: "rc-heal-fixture", repoPath: "C:/repo", repoName: "repo", defaultBranch: "master", createdAt: new Date().toISOString() });
    statusIds = await initializeProjectStatuses(projectId, new Date().toISOString(), db);
  });

  afterEach(() => {
    while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  it("a red rc sweep files ONE heal ticket keyed to the rc, tagged, critical, top of the backlog — whatever the posture", async () => {
    // `standard`'s red-base policy is `block`: #1233 files nothing there, the rc lane files regardless.
    await db.insert(preferences).values({ key: `risk_posture_${projectId}`, value: "standard", updatedAt: new Date().toISOString() });
    invalidatePreferencesCache();

    const result = await rcSweep("red");
    expect(result.action).toBe("created");
    const rows = await healRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].externalKey).toBe(healTicketExternalKey(projectId, failureSignature(RED_SUITES), RC));
    expect(rows[0].priority).toBe("critical");
    expect(rows[0].sortOrder).toBeLessThan(0);
    expect(rows[0].title).toContain(RC);
    // The body names the rc, every failing suite, the reproduce command and the merge range.
    expect(rows[0].description).toContain(`\`${RC}\``);
    for (const suite of RED_SUITES) expect(rows[0].description).toContain(suite);
    expect(rows[0].description).toContain("cd packages/server && pnpm --silent exec vitest run");
    expect(rows[0].description).toContain("master (nightly sweep)");
    expect(await tagNames(rows[0].id)).toContain(HEAL_TICKET_TAG);
    expect(await tagNames(rows[0].id)).not.toContain("no-auto-start");
  });

  it("dedupes by signature PER rc: same set on the same rc refreshes, the same set on the next rc files a second ticket", async () => {
    expect((await rcSweep("red")).action).toBe("created");
    expect((await rcSweep("red")).action).toBe("updated");
    expect(await healRows()).toHaveLength(1);

    expect((await rcSweep("red", RC_NEXT)).action).toBe("created");
    expect(await healRows()).toHaveLength(2);
    expect(await listOpenRcHealTickets(projectId, RC, db)).toHaveLength(1);
    expect(await listOpenRcHealTickets(projectId, RC_NEXT, db)).toHaveLength(1);

    // A different failing set on the same rc is a second ticket beside the first.
    expect((await rcSweep("red", RC, [RED_SUITES[0]])).action).toBe("created");
    expect(await listOpenRcHealTickets(projectId, RC, db)).toHaveLength(2);
  });

  it("a non-verdict files nothing; a green rc sweep comments and leaves the ticket open for the merge-back", async () => {
    expect((await rcSweep("timeout")).action).toBe("skipped_no_verdict");
    expect(await healRows()).toHaveLength(0);

    await rcSweep("red");
    const green = await rcSweep("green", RC, []);
    expect(green.action).toBe("commented");
    expect(await listOpenRcHealTickets(projectId, RC, db)).toHaveLength(1);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, green.issueIds[0]));
    expect(comments.some((c) => c.body.includes("merge-back"))).toBe(true);
  });

  it("`heal_review_posture_<id>` pins the ticket's review posture through a `risk:` tag; an unknown level pins nothing", async () => {
    await db.insert(preferences).values({ key: `heal_review_posture_${projectId}`, value: "standard", updatedAt: new Date().toISOString() });
    invalidatePreferencesCache();
    const created = await rcSweep("red");
    expect(await tagNames(created.issueIds[0])).toContain("risk:standard");

    await db.update(preferences).set({ value: "bogus" }).where(eq(preferences.key, `heal_review_posture_${projectId}`));
    invalidatePreferencesCache();
    const second = await rcSweep("red", RC_NEXT);
    expect((await tagNames(second.issueIds[0])).some((t) => t.startsWith("risk:"))).toBe(false);
  });

  it("a green MASTER sweep closes base-lane tickets only — the rc heal ticket survives it (#1233 lane filter)", async () => {
    // `sprint` files base-lane heal tickets (allow-file-debt-ticket).
    await db.insert(preferences).values({ key: `risk_posture_${projectId}`, value: "sprint", updatedAt: new Date().toISOString() });
    invalidatePreferencesCache();
    await reconcileBaseHealthHealTicket({ projectId, outcome: "red", sha: SHA, branch: "master", failedSuites: RED_SUITES }, db);
    await rcSweep("red");
    expect(await listOpenHealTickets(projectId, db, { lane: "all" })).toHaveLength(2);
    expect(await listOpenHealTickets(projectId, db)).toHaveLength(1);

    const closed = await reconcileBaseHealthHealTicket({ projectId, outcome: "green", sha: "beef1234beef1234beef1234beef1234beef1234", branch: "master", failedSuites: [] }, db);
    expect(closed.action).toBe("closed");
    expect(await listOpenHealTickets(projectId, db, { lane: "all" })).toHaveLength(1);
    expect(await listOpenRcHealTickets(projectId, RC, db)).toHaveLength(1);
  });

  it("the merge-back landing closes the rc's heal tickets; any other merged issue is a no-op", async () => {
    await rcSweep("red");
    await rcSweep("red", RC, [RED_SUITES[0]]);
    expect(await listOpenRcHealTickets(projectId, RC, db)).toHaveLength(2);

    const ordinary = randomUUID();
    await db.insert(issues).values({ id: ordinary, issueNumber: 900, title: "ordinary", description: null, priority: "medium", sortOrder: 0, statusId: statusIds.Todo, projectId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    expect(await closeHealTicketsForMergedIssue({ issueId: ordinary, projectId }, db)).toBeNull();
    expect(await listOpenRcHealTickets(projectId, RC, db)).toHaveLength(2);

    const mergeBack = randomUUID();
    await db.insert(issues).values({ id: mergeBack, issueNumber: 901, title: `merge-back: ${RC}`, description: null, priority: "high", sortOrder: 0, statusId: statusIds.Todo, projectId, externalKey: mergeBackExternalKey(projectId, RC), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const result = await closeHealTicketsForMergedIssue({ issueId: mergeBack, projectId }, db);
    expect(result?.action).toBe("closed");
    expect(result?.issueIds).toHaveLength(2);
    expect(await listOpenRcHealTickets(projectId, RC, db)).toHaveLength(0);
    const rows = await healRows();
    expect(rows.every((r) => r.statusId === statusIds.Done)).toBe(true);
  });

  it("an abandoned rc retargets its open heal tickets and their workspaces to the next candidate — nothing closes", async () => {
    const created = await rcSweep("red");
    const now = new Date().toISOString();
    const wsId = randomUUID();
    await db.insert(workspaces).values({ id: wsId, issueId: created.issueIds[0], branch: "feature/ak-7-heal", workingDir: "/tmp/wt", baseBranch: RC, isDirect: false, status: "active", provider: "claude", createdAt: now, updatedAt: now });

    const result = await retargetRcHealTickets({ projectId, fromBranch: RC, toBranch: RC_NEXT }, db);
    expect(result.action).toBe("retargeted");
    expect(result.reason).toContain("1 workspace base(s)");
    expect(await listOpenRcHealTickets(projectId, RC, db)).toHaveLength(0);
    const moved = await listOpenRcHealTickets(projectId, RC_NEXT, db);
    expect(moved).toHaveLength(1);
    expect(parseHealTicketExternalKey(moved[0].externalKey)).toEqual({ projectId, signature: failureSignature(RED_SUITES), branch: RC_NEXT });
    const ws = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
    expect(ws[0].baseBranch).toBe(RC_NEXT);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, created.issueIds[0]));
    expect(comments.some((c) => c.body.includes(RC_NEXT) && c.body.includes("update-base"))).toBe(true);

    // The next red sweep of the new rc refreshes the moved ticket rather than filing a second.
    expect((await rcSweep("red", RC_NEXT)).action).toBe("updated");
    expect(await healRows()).toHaveLength(1);
  });

  it("the gate forces the rc's failing suites for a workspace based on it, and only the ones that exist in the worktree", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "ak-heal-gate-"));
    tempDirs.push(worktree);
    mkdirSync(join(worktree, "packages/server/src/__tests__"), { recursive: true });
    writeFileSync(join(worktree, RED_SUITES[0]), "// present\n");
    const now = new Date().toISOString();
    await db.insert(baseBranchHealth).values({ id: randomUUID(), projectId, sha: SHA, branch: RC, outcome: "red", durationMs: 1, failedSuites: JSON.stringify(RED_SUITES), createdAt: now });

    const forced = await resolveHealForcedSuites({ projectId, baseBranch: RC, workingDir: worktree }, db);
    expect(forced).toEqual([RED_SUITES[0]]);
    // The merge-back (base master) and any ordinary workspace force nothing.
    expect(await resolveHealForcedSuites({ projectId, baseBranch: "master", workingDir: worktree }, db)).toEqual([]);

    // ...and they ride the same door as an added test file, unioned with the diff's own.
    const env = resolveImpactSelectorEnv({ strategy: "impact", baseBranch: RC, changedFiles: ["packages/server/src/services/x.ts", "packages/server/src/__tests__/x.test.ts"], fileExists: () => true, forcedTestFiles: forced });
    expect(env.KANBAN_TEST_NEW_FILES!.split(",").sort()).toEqual(["packages/server/src/__tests__/x.test.ts", RED_SUITES[0]].sort());
    expect(env.KANBAN_IMPACT_BASE).toBe(RC);
  });

  it("the read model counts the rc's open heal tickets and the red it inherited from master", async () => {
    const now = new Date().toISOString();
    await db.insert(baseBranchHealth).values({ id: randomUUID(), projectId, sha: "1111111111111111111111111111111111111111", branch: "master", outcome: "red", durationMs: 1, failedSuites: JSON.stringify([RED_SUITES[1], "another.test.ts"]), createdAt: now });
    await rcSweep("red");
    const summary = await rcHealSummary(projectId, { branch: RC, failedSuites: RED_SUITES }, db);
    expect(summary).toEqual({ openHealTickets: 1, inheritedRed: 1 });
    expect(await rcHealSummary(projectId, null, db)).toBeNull();
  });
});
