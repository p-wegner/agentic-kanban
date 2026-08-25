/**
 * #893: a completed pre-merge gate PASS must survive a backend restart.
 *
 * The measured failure: `POST /:id/merge` ran its gate inline for ~39 minutes and PASSED; a
 * direct-master commit touched server source; tsx watch restarted the backend; the request
 * (and the in-memory #492 tree memo) died with it, and the retry re-paid the entire run for
 * code that had already been verified ten minutes earlier.
 *
 * `reusePersistedGateVerdict` is the recovery half: it turns the verdict persisted in
 * `workspace_merge_gate` back into an `already-passed` token — but ONLY when the persisted
 * proof still describes the exact merge about to happen (same branch tip, same base tip,
 * same verification tier) and the run is younger than the reuse bound. Everything else, and
 * every read error, falls back to a real gate run. Failures are never persisted by this
 * path, so a red verdict can never be replayed to block a merge.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";
import {
  reusePersistedGateVerdict,
  describePersistedGateVerdict,
  PERSISTED_GATE_VERDICT_MAX_AGE_MS,
} from "../services/workspace-merge-gate.js";
import { setMergeGateEvidence } from "../repositories/merge-gate.repository.js";
import { projects, projectStatuses, issues, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";

const NOW_MS = Date.parse("2026-08-24T12:00:00.000Z");
const FRESH_RAN_AT = new Date(NOW_MS - 10 * 60 * 1000).toISOString(); // 10 minutes old

const WORKSPACE = { id: "ws-1", workingDir: "/repo/.worktrees/ws-1", baseBranch: "master" };

interface EvidenceRow {
  workspaceId: string;
  ranAt: string | null;
  stage: string | null;
  source: string | null;
  branchSha: string | null;
  baseSha: string | null;
  verificationKey: string | null;
}

function evidenceRow(overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    workspaceId: "ws-1",
    ranAt: FRESH_RAN_AT,
    stage: "verify",
    source: "pre-lock-merge",
    branchSha: "branch-tip",
    baseSha: "base-tip",
    verificationKey: "tier-key",
    ...overrides,
  };
}

async function attempt(args: {
  evidence?: EvidenceRow | undefined;
  currentShas?: { branchSha?: string; baseSha?: string };
  currentKey?: string;
  nowMs?: number;
  readEvidence?: () => Promise<never>;
}) {
  return reusePersistedGateVerdict({
    workspaceId: "ws-1",
    workspace: WORKSPACE,
    projectId: "project-1",
    database: {} as Database,
    nowMs: args.nowMs ?? NOW_MS,
    readEvidence: args.readEvidence ?? (async () => args.evidence),
    readShas: async () => args.currentShas ?? { branchSha: "branch-tip", baseSha: "base-tip" },
    readVerificationKey: async () => args.currentKey ?? "tier-key",
  });
}

describe("reusePersistedGateVerdict (#893)", () => {
  it("reuses a fresh PASS whose tips and verification tier still match", async () => {
    const token = await attempt({ evidence: evidenceRow() });
    expect(token?.kind).toBe("already-passed");
    if (token?.kind !== "already-passed") throw new Error("unreachable");
    expect(token.evidence.ranAt).toBe(FRESH_RAN_AT);
    expect(token.evidence.stage).toBe("verify");
    expect(token.evidence.branchSha).toBe("branch-tip");
    expect(token.evidence.baseSha).toBe("base-tip");
    // Part 3: the token must SAY the verdict was reused, not imply the gate ran now.
    expect(token.evidence.source).toContain("persisted verdict reused");
    expect(token.evidence.source).toContain("pre-lock-merge");
  });

  it("re-runs when the branch tip moved since the recorded pass", async () => {
    expect(await attempt({ evidence: evidenceRow(), currentShas: { branchSha: "new-commit", baseSha: "base-tip" } })).toBeNull();
  });

  it("re-runs when the BASE moved — the merge RESULT is no longer what was tested", async () => {
    expect(await attempt({ evidence: evidenceRow(), currentShas: { branchSha: "branch-tip", baseSha: "another-merge-landed" } })).toBeNull();
  });

  it("re-runs when either current tip is unresolvable — reuse never guesses", async () => {
    expect(await attempt({ evidence: evidenceRow(), currentShas: { branchSha: "branch-tip" } })).toBeNull();
    expect(await attempt({ evidence: evidenceRow(), currentShas: {} })).toBeNull();
  });

  it("re-runs when the verification tier changed since the pass (a level may only weaken VISIBLY)", async () => {
    expect(await attempt({ evidence: evidenceRow(), currentKey: "tightened-tier-key" })).toBeNull();
  });

  it("re-runs for pre-#893 evidence that recorded no verification key", async () => {
    expect(await attempt({ evidence: evidenceRow({ verificationKey: null }) })).toBeNull();
  });

  it("re-runs when the recorded tips are incomplete", async () => {
    expect(await attempt({ evidence: evidenceRow({ branchSha: null }) })).toBeNull();
    expect(await attempt({ evidence: evidenceRow({ baseSha: null }) })).toBeNull();
  });

  it("never honours a record of NO verification (stage none/null — #642's rule)", async () => {
    expect(await attempt({ evidence: evidenceRow({ stage: "none" }) })).toBeNull();
    expect(await attempt({ evidence: evidenceRow({ stage: null }) })).toBeNull();
  });

  it("bounds reuse: a verdict older than the max age re-runs even with matching tips", async () => {
    const stale = new Date(NOW_MS - PERSISTED_GATE_VERDICT_MAX_AGE_MS - 1000).toISOString();
    expect(await attempt({ evidence: evidenceRow({ ranAt: stale }) })).toBeNull();
    // Just inside the bound is still reusable — the bound is hours, not the 15-min token TTL.
    const justInside = new Date(NOW_MS - PERSISTED_GATE_VERDICT_MAX_AGE_MS + 60_000).toISOString();
    expect((await attempt({ evidence: evidenceRow({ ranAt: justInside }) }))?.kind).toBe("already-passed");
  });

  it("rejects a future-dated or unparseable ranAt", async () => {
    expect(await attempt({ evidence: evidenceRow({ ranAt: new Date(NOW_MS + 60_000).toISOString() }) })).toBeNull();
    expect(await attempt({ evidence: evidenceRow({ ranAt: "not-a-date" }) })).toBeNull();
  });

  it("re-runs when there is no persisted verdict at all", async () => {
    expect(await attempt({ evidence: undefined })).toBeNull();
  });

  it("a broken evidence read falls back to a real run instead of throwing into the merge", async () => {
    expect(
      await attempt({
        readEvidence: async () => {
          throw new Error("db locked");
        },
      }),
    ).toBeNull();
  });
});

describe("describePersistedGateVerdict (#893 part 3 — merge-status after a restart)", () => {
  const T0 = "2026-08-23T00:00:00.000Z";

  async function seedWorkspace(db: ReturnType<typeof createTestDb>["db"]): Promise<string> {
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(projects).values({
      id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
      defaultBranch: "master", createdAt: T0, updatedAt: T0,
    });
    await db.insert(projectStatuses).values({
      id: statusId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: T0,
    });
    await db.insert(issues).values({
      id: issueId, issueNumber: 1, title: "Issue 1", priority: "medium", sortOrder: 0,
      statusId, projectId, createdAt: T0, updatedAt: T0,
    });
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch: "feature/ak-1", workingDir: "/repo/.worktrees/ws",
      baseBranch: "master", status: "idle", provider: "claude", createdAt: T0, updatedAt: T0,
    });
    return workspaceId;
  }

  it("reports a persisted PASS, marked reusable when it has tips + tier and is fresh", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    const ranAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await setMergeGateEvidence(workspaceId, {
      ranAt, stage: "verify", source: "pre-lock-merge",
      branchSha: "aaa", baseSha: "bbb", verificationKey: "key-1",
    }, db);

    const verdict = await describePersistedGateVerdict(workspaceId, db);
    expect(verdict).toMatchObject({ ranAt, stage: "verify", reusable: true });
  });

  it("reports an old or tier-less PASS as not reusable, and nothing as null", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    expect(await describePersistedGateVerdict(workspaceId, db)).toBeNull();

    const stale = new Date(Date.now() - PERSISTED_GATE_VERDICT_MAX_AGE_MS - 60_000).toISOString();
    await setMergeGateEvidence(workspaceId, {
      ranAt: stale, stage: "verify", source: "pre-lock-merge",
      branchSha: "aaa", baseSha: "bbb", verificationKey: "key-1",
    }, db);
    expect((await describePersistedGateVerdict(workspaceId, db))?.reusable).toBe(false);
  });

  it("does not report a record of NO verification as a verdict", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await setMergeGateEvidence(workspaceId, {
      ranAt: new Date().toISOString(), stage: "none", source: "x",
      branchSha: null, baseSha: null,
    }, db);
    expect(await describePersistedGateVerdict(workspaceId, db)).toBeNull();
  });
});
