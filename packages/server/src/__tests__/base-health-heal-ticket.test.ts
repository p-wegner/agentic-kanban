/**
 * #1016 — land-then-heal's disclosure channel: when the base-health sweep goes red on a project
 * whose effective `redBasePolicy` is `allow-file-debt-ticket`, ONE `heal` ticket carries the
 * failing-suite list instead of N per-branch gates rediscovering it.
 *
 * The acceptance criteria of the ticket, one `it` each: a forced red sweep files exactly one
 * ticket, a second red sweep updates it (still one), a green sweep closes it, and a project on
 * `block` gets nothing at all.
 *
 * The policy is deliberately driven through the PREF here (`risk_posture_<projectId>`), not by
 * injecting a posture object: the whole point of #1015's resolver is that the red-base decision
 * is read in exactly one place, and a test that injected the answer would pass with the
 * resolver bypassed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, like } from "drizzle-orm";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { issueComments, issues, issueTags, preferences, projects, tags } from "@agentic-kanban/shared/schema";
import { failureSignature, VERIFY_FAILED_SIGNATURE } from "../lib/heal-failure-signature.js";
import {
  healTicketExternalKey,
  healTicketKeyScanPrefix,
  parseHealTicketExternalKey,
  HEAL_TICKET_TAG,
} from "../lib/heal-ticket-key.js";
import { createTestDb } from "./helpers/test-db.js";
import { initializeProjectStatuses } from "../repositories/issue.repository.js";
import { invalidatePreferencesCache } from "../repositories/preferences.repository.js";
import { listOpenHealTickets, reconcileBaseHealthHealTicket } from "../services/base-health-heal-ticket.service.js";

const RED_SUITES = [
  "packages/server/src/__tests__/merge-gate.test.ts",
  "packages/shared/__tests__/git-exec-single-spawn.test.ts",
];

describe("failure signature (#1233)", () => {
  it("is order- and duplicate-insensitive, slash-normalised, and constant for a suite-less red", () => {
    const a = failureSignature(["b.test.ts", "a.test.ts"]);
    expect(failureSignature(["a.test.ts", "b.test.ts", "a.test.ts "])).toBe(a);
    expect(failureSignature(["a.test.ts", "b.test.ts"].map((s) => `packages\\${s}`)))
      .toBe(failureSignature(["packages/a.test.ts", "packages/b.test.ts"]));
    expect(failureSignature(["a.test.ts"])).not.toBe(a);
    expect(failureSignature([])).toBe(VERIFY_FAILED_SIGNATURE);
    expect(failureSignature(null)).toBe(VERIFY_FAILED_SIGNATURE);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it("the key carries the signature, parses back, and a pre-#1233 key still parses", () => {
    const key = healTicketExternalKey("p1", "abc123");
    expect(key.startsWith(healTicketKeyScanPrefix("p1"))).toBe(true);
    expect(parseHealTicketExternalKey(key)).toEqual({ projectId: "p1", signature: "abc123" });
    expect(parseHealTicketExternalKey("base-health-heal:p1")).toEqual({ projectId: "p1", signature: null });
    expect(parseHealTicketExternalKey("plugin-loop:p1:x")).toBeNull();
  });
});

describe("base-health heal ticket (#1016)", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let projectId: string;
  let statusIds: Record<string, string>;

  async function setPosture(level: string): Promise<void> {
    await db.delete(preferences).where(eq(preferences.key, `risk_posture_${projectId}`));
    await db.insert(preferences).values({
      key: `risk_posture_${projectId}`,
      value: level,
      updatedAt: new Date().toISOString(),
    });
    invalidatePreferencesCache();
  }

  async function sweep(
    outcome: "red" | "green" | "timeout",
    failedSuites: string[] | null = null,
    extra: { repoPath?: string; lastGreenSha?: string | null; sha?: string } = {},
  ) {
    return reconcileBaseHealthHealTicket({
      projectId,
      outcome,
      sha: extra.sha ?? (outcome === "green" ? "beef1234beef1234beef1234beef1234beef1234" : "cafe9876cafe9876cafe9876cafe9876cafe9876"),
      branch: "master",
      failedSuites,
      healthRowId: "sweep-row-1",
      message: outcome === "red" ? "2 failed | 781 passed" : undefined,
      ...extra,
    }, db);
  }

  async function healRows() {
    return db
      .select()
      .from(issues)
      .where(like(issues.externalKey, `${healTicketKeyScanPrefix(projectId)}%`));
  }

  beforeEach(async () => {
    ({ db } = createTestDb());
    invalidatePreferencesCache();
    projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      name: "heal-fixture",
      repoPath: "C:/repo",
      repoName: "repo",
      createdAt: new Date().toISOString(),
    });
    statusIds = await initializeProjectStatuses(projectId, new Date().toISOString(), db);
    // `sprint` is the level whose `redBasePolicy` is `allow-file-debt-ticket`.
    await setPosture("sprint");
  });

  it("files exactly one heal ticket on a red sweep — tagged, critical, top of the backlog", async () => {
    // A pre-existing backlog issue, so "top of the backlog" is an assertion about ORDER rather
    // than about the constant 0 an empty project would produce either way.
    await db.insert(issues).values({
      id: randomUUID(), issueNumber: 1, title: "some other work", description: null,
      priority: "medium", issueType: "task", skipAutoReview: false, estimate: null,
      sortOrder: 0, statusId: statusIds.Todo, projectId,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const result = await sweep("red", RED_SUITES);
    expect(result.action).toBe("created");

    const rows = await healRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].priority).toBe("critical");
    expect(rows[0].sortOrder).toBeLessThan(0);
    expect(rows[0].title).toContain("2 failing suites");
    // The body is the whole point of the ticket: the suites, the sha, and the way back to the
    // sweep row that produced the verdict.
    for (const suite of RED_SUITES) expect(rows[0].description).toContain(suite);
    expect(rows[0].description).toContain("cafe9876cafe9876cafe9876cafe9876cafe9876");
    expect(rows[0].description).toContain("sweep-row-1");

    const linked = await db
      .select({ name: tags.name })
      .from(issueTags)
      .innerJoin(tags, eq(issueTags.tagId, tags.id))
      .where(eq(issueTags.issueId, rows[0].id));
    expect(linked.map((t) => t.name)).toContain(HEAL_TICKET_TAG);
  });

  it("a second red sweep with the SAME failure signature refreshes the open ticket — never a second one (#1233)", async () => {
    const first = await sweep("red", RED_SUITES);
    expect(first.action).toBe("created");

    // Same set, other order, a Windows spelling and a new sha: one signature, one ticket.
    const second = await sweep("red", [RED_SUITES[1], RED_SUITES[0].replace(/\//g, "\\")], { sha: "d00d".repeat(10) });
    expect(second.action).toBe("updated");
    expect(second.issueId).toBe(first.issueId);

    const rows = await healRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].externalKey).toBe(healTicketExternalKey(projectId, failureSignature(RED_SUITES)));
    // The body now describes the LATEST sweep of that signature.
    expect(rows[0].description).toContain("d00d".repeat(10));
    expect(await listOpenHealTickets(projectId, db)).toHaveLength(1);
  });

  it("a red with a DIFFERENT failure signature files a second ticket beside the first (#1233)", async () => {
    const first = await sweep("red", RED_SUITES);
    const second = await sweep("red", ["packages/server/src/__tests__/only-one-now.test.ts"]);
    expect(second.action).toBe("created");
    expect(second.issueId).not.toBe(first.issueId);

    const rows = await healRows();
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(second.issueId!)?.title).toContain("1 failing suite");
    expect(byId.get(second.issueId!)?.description).toContain("only-one-now.test.ts");
    // The first ticket keeps describing ITS red — nothing rewrote it under a builder.
    expect(byId.get(first.issueId!)?.description).toContain("merge-gate.test.ts");
    expect(await listOpenHealTickets(projectId, db)).toHaveLength(2);
  });

  it("closes EVERY open heal ticket, each with a comment, when a sweep goes green", async () => {
    const filed = await sweep("red", RED_SUITES);
    const other = await sweep("red", ["packages/server/src/__tests__/only-one-now.test.ts"]);
    const closed = await sweep("green", []);
    expect(closed.action).toBe("closed");
    expect(closed.closedIssueIds?.sort()).toEqual([filed.issueId, other.issueId].sort());

    const rows = await healRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.statusId).toBe(statusIds.Done);
    expect(await listOpenHealTickets(projectId, db)).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, filed.issueId!));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("GREEN");

    // A green sweep with nothing open is a no-op, not a second close.
    expect((await sweep("green", [])).action).toBe("noop");
  });

  it("under `iterate` (#1233) a red files exactly one open heal ticket, the same red files none, a green closes it", async () => {
    await setPosture("iterate");
    expect((await sweep("red", RED_SUITES)).action).toBe("created");
    expect(await listOpenHealTickets(projectId, db)).toHaveLength(1);

    expect((await sweep("red", RED_SUITES)).action).toBe("updated");
    expect(await listOpenHealTickets(projectId, db)).toHaveLength(1);
    expect(await healRows()).toHaveLength(1);

    expect((await sweep("green", [])).action).toBe("closed");
    expect(await listOpenHealTickets(projectId, db)).toHaveLength(0);
  });

  it("files nothing under `report` — the softest policy discloses in the delivery view only (#1233)", async () => {
    await setPosture("sprint");
    await db.insert(preferences).values({ key: `red_base_policy_${projectId}`, value: "report", updatedAt: new Date().toISOString() });
    invalidatePreferencesCache();
    const result = await sweep("red", RED_SUITES);
    expect(result.action).toBe("skipped_policy");
    expect(result.reason).toContain("report");
    expect(await healRows()).toHaveLength(0);
  });

  describe("merges since the last green sweep, through the git adapter (#1233)", () => {
    let repo: string;
    const git = (args: string[]) => gitExecOrThrow(args, { cwd: repo });
    const commit = async (file: string, subject: string) => {
      writeFileSync(join(repo, file), subject, "utf8");
      await git(["add", file]);
      await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", subject]);
      return (await git(["rev-parse", "HEAD"])).trim();
    };

    beforeEach(async () => {
      repo = mkdtempSync(join(tmpdir(), "kanban-heal-log-"));
      await git(["init", "-q", "-b", "master"]);
    });
    afterEach(() => {
      try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    it("names every commit between the last green sha and the red sha, and nothing before", async () => {
      await commit("0.txt", "chore: before green");
      const green = await commit("1.txt", "feat: last green");
      await commit("2.txt", "feat(#1): landed after green");
      const red = await commit("3.txt", "fix(#2): also landed after green");

      const result = await sweep("red", RED_SUITES, { repoPath: repo, lastGreenSha: green, sha: red });
      expect(result.action).toBe("created");
      const [row] = await healRows();
      expect(row.description).toContain("feat(#1): landed after green");
      expect(row.description).toContain("fix(#2): also landed after green");
      expect(row.description).not.toContain("feat: last green");
      expect(row.description).not.toContain("chore: before green");
      expect(row.description).toContain(`Last green sweep: \`${green}\``);
    });

    it("says so when there is no green to measure from, or the repo cannot be read", async () => {
      const red = await commit("a.txt", "feat: only commit");
      const none = await sweep("red", RED_SUITES, { repoPath: repo, lastGreenSha: null, sha: red });
      expect(none.action).toBe("created");
      expect((await healRows())[0].description).toContain("No green sweep is recorded");

      await sweep("green", []);
      const unreadable = await sweep("red", RED_SUITES, { repoPath: join(tmpdir(), "no-such-repo-1233"), lastGreenSha: "1".repeat(40), sha: red });
      expect(unreadable.action).toBe("created");
      const open = await listOpenHealTickets(projectId, db);
      expect(open).toHaveLength(1);
      expect(open[0].description).toContain("Could not read");
    });
  });

  it("files a fresh ticket for a NEW red episode once the previous one is closed", async () => {
    await sweep("red", RED_SUITES);
    await sweep("green", []);
    const reopened = await sweep("red", RED_SUITES);
    expect(reopened.action).toBe("created");

    // Two rows share the key — the invariant is "at most one OPEN heal ticket", which keeps a
    // legible history of episodes rather than reopening one ticket forever.
    const rows = await healRows();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.statusId !== statusIds.Done)).toHaveLength(1);
  });

  it("files nothing for a project whose red-base policy is 'block'", async () => {
    await setPosture("strict");
    const result = await sweep("red", RED_SUITES);
    expect(result.action).toBe("skipped_policy");
    expect(result.reason).toContain("block");
    expect(await healRows()).toHaveLength(0);
  });

  it("files nothing for 'allow-known-debt' either — only the debt-ticket policy files", async () => {
    await setPosture("fast");
    expect((await sweep("red", RED_SUITES)).action).toBe("skipped_policy");
    expect(await healRows()).toHaveLength(0);
  });

  it("files nothing for a project with no posture chosen at all", async () => {
    await db.delete(preferences).where(eq(preferences.key, `risk_posture_${projectId}`));
    invalidatePreferencesCache();
    expect((await sweep("red", RED_SUITES)).action).toBe("skipped_policy");
    expect(await healRows()).toHaveLength(0);
  });

  it("neither files nor closes on a probe that produced no verdict", async () => {
    expect((await sweep("timeout")).action).toBe("skipped_no_verdict");
    expect(await healRows()).toHaveLength(0);

    await sweep("red", RED_SUITES);
    // A timeout AFTER a red must not close the open ticket: it observed nothing.
    expect((await sweep("timeout")).action).toBe("skipped_no_verdict");
    const rows = await healRows();
    expect(rows[0].statusId).not.toBe(statusIds.Done);
  });
});
