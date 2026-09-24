/**
 * #1250 — `POST /api/workspaces/:id/merge/bank-shrinks`: the edits land on the branch, the
 * commit carries the promised subject, and every refusal leaves the tree as found.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { bankMergeShrinks, bankShrinksCommitSubject, rewriteBaselineEntry } from "../services/merge-bank-shrinks.service.js";
import { deriveMergeFixHint } from "../services/merge-failure-fix-hint.js";
import { failMergeJob, resetMergeJobs, startMergeJob } from "../services/merge-job.service.js";

const CLIENT_BASELINE = "packages/client/src/__tests__/function-nloc-baseline.ts";
const RUNTIME_RATCHET = "packages/server/src/__tests__/always-run-guard-runtime-ratchet.test.ts";

const RED = `
 FAIL  packages/client/src/__tests__/function-nloc-ratchet.test.ts > client function nloc is a shrink-only ring (#763) > no baseline entry is stale
+   "components/TableView.tsx::TableView: 371 < baseline 416 — lower it to 371",
+   "components/WorkspaceCard.tsx::WorkspaceCard: 560 < baseline 570 — lower it to 560",
`;

const mergeWorkspaceDeduped = vi.hoisted(() => vi.fn(async (id: string) => ({ id, mergeOutput: "merged" })));
const workspaceRow = vi.hoisted(() => ({ current: null as null | { id: string; issueId: string; workingDir: string | null } }));

vi.mock("../services/merge-backoff.service.js", () => ({ resetMergeBackoffForExplicitMerge: vi.fn(async () => {}) }));
vi.mock("../services/workspace.service.js", () => ({
  createWorkspaceService: vi.fn(() => ({ mergeWorkspaceDeduped })),
}));
vi.mock("../repositories/workspace-reads.repository.js", () => ({
  getWorkspaceById: vi.fn(async () => workspaceRow.current),
}));
vi.mock("../repositories/issue.repository.js", () => ({
  getIssueSummary: vi.fn(async () => ({ issueNumber: 1250 })),
}));

import { createWorkspaceMergeBankShrinksRoute } from "../routes/workspace-merge-bank-shrinks.js";

let repo: string;
const git = (args: string[]) => gitExecOrThrow(args, { cwd: repo });

function seed(file: string, content: string) {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), content, "utf8");
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "kanban-bank-shrinks-"));
  await git(["init", "-q", "-b", "master"]);
  await git(["config", "user.email", "t@t"]);
  await git(["config", "user.name", "t"]);
  seed(CLIENT_BASELINE, [
    "export const FUNCTION_NLOC_BASELINE: Record<string, number> = {",
    '  "components/TableView.tsx::TableView": 416,',
    "  // master shrank this one; #972 never touched it.",
    '  "components/WorkspaceCard.tsx::WorkspaceCard": 570,',
    "};",
    "",
  ].join("\n"));
  seed(RUNTIME_RATCHET, "const BASELINE_TOTAL_MS = 562_000;\nconst MERGE_FLOOR_BASELINE_MS = 66_000;\n");
  seed("src/app.ts", "export const a = 1;\n");
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "seed"]);
  resetMergeJobs();
  workspaceRow.current = { id: "ws-1", issueId: "issue-1", workingDir: repo };
  mergeWorkspaceDeduped.mockClear();
});

afterEach(() => {
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("rewriteBaselineEntry", () => {
  it("lowers exactly the named map entry and the named const, keeping separators and comments", () => {
    const map = readFileSync(join(repo, CLIENT_BASELINE), "utf8");
    const r = rewriteBaselineEntry(map, { baselineFile: CLIENT_BASELINE, key: "components/TableView.tsx::TableView", from: 416, to: 371 });
    expect(r.ok && r.source).toContain('  "components/TableView.tsx::TableView": 371,');
    expect(r.ok && r.source).toContain('  "components/WorkspaceCard.tsx::WorkspaceCard": 570,');
    expect(r.ok && r.previous).toBe(416);
    const consts = readFileSync(join(repo, RUNTIME_RATCHET), "utf8");
    const c = rewriteBaselineEntry(consts, { baselineFile: RUNTIME_RATCHET, key: "BASELINE_TOTAL_MS", from: null, to: 512345 });
    expect(c.ok && c.source).toBe("const BASELINE_TOTAL_MS = 512345;\nconst MERGE_FLOOR_BASELINE_MS = 66_000;\n");
    expect(c.ok && c.previous).toBe(562000);
  });

  it("refuses a missing key, a moved number, and a non-shrink", () => {
    const map = readFileSync(join(repo, CLIENT_BASELINE), "utf8");
    expect(rewriteBaselineEntry(map, { baselineFile: CLIENT_BASELINE, key: "a.ts::a", from: 1, to: 0 })).toMatchObject({ ok: false, reason: expect.stringContaining("no entry for a.ts::a") });
    expect(rewriteBaselineEntry(map, { baselineFile: CLIENT_BASELINE, key: "components/TableView.tsx::TableView", from: 400, to: 371 })).toMatchObject({ ok: false, reason: expect.stringContaining("holds components/TableView.tsx::TableView at 416, not the 400") });
    expect(rewriteBaselineEntry(map, { baselineFile: CLIENT_BASELINE, key: "components/TableView.tsx::TableView", from: 416, to: 420 })).toMatchObject({ ok: false, reason: expect.stringContaining("not a shrink") });
  });
});

describe("bankMergeShrinks", () => {
  it("applies the hint's edits and commits them on the branch with the promised subject", async () => {
    const hint = deriveMergeFixHint(RED)!;
    const before = (await git(["rev-parse", "HEAD"])).trim();
    const result = await bankMergeShrinks({ workingDir: repo, issueNumber: 1250, hint });
    expect(result.applied).toEqual(hint.edits);
    expect(result.subject).toBe("test(#1250): bank the nloc shrinks the merge gate named");
    expect(result.committed).not.toBe(before);
    expect((await git(["log", "-1", "--format=%s"])).trim()).toBe(result.subject);
    expect((await git(["status", "--porcelain"])).trim()).toBe("");
    const banked = readFileSync(join(repo, CLIENT_BASELINE), "utf8");
    expect(banked).toContain('"components/TableView.tsx::TableView": 371,');
    expect(banked).toContain('"components/WorkspaceCard.tsx::WorkspaceCard": 560,');
    expect(bankShrinksCommitSubject(null)).toBe("test: bank the nloc shrinks the merge gate named");
  });

  it("refuses a worktree dirty outside the baseline files and leaves it as found", async () => {
    writeFileSync(join(repo, "src/app.ts"), "export const a = 2;\n", "utf8");
    const hint = deriveMergeFixHint(RED)!;
    await expect(bankMergeShrinks({ workingDir: repo, issueNumber: 1250, hint })).rejects.toThrow(/uncommitted changes outside the baseline files \(src\/app.ts\)/);
    expect(readFileSync(join(repo, CLIENT_BASELINE), "utf8")).toContain('"components/TableView.tsx::TableView": 416,');
    expect((await git(["log", "--format=%s"])).trim()).toBe("seed");
  });

  it("tolerates an already-edited baseline file, but refuses when a number no longer matches, writing nothing", async () => {
    // A hand edit of the baseline itself is the ONE dirty file that is allowed …
    writeFileSync(join(repo, CLIENT_BASELINE), readFileSync(join(repo, CLIENT_BASELINE), "utf8").replace("416,", "416, // touched"), "utf8");
    const ok = await bankMergeShrinks({ workingDir: repo, issueNumber: 1250, hint: deriveMergeFixHint(RED)! });
    expect(ok.committed).toBeTruthy();
    // … while a hint whose numbers the file no longer holds is refused before any write.
    const stale = deriveMergeFixHint(RED)!;
    await expect(bankMergeShrinks({ workingDir: repo, issueNumber: 1250, hint: stale })).rejects.toThrow(/holds components\/TableView.tsx::TableView at 371, not the 416/);
    expect((await git(["status", "--porcelain"])).trim()).toBe("");
  });
});

describe("POST /api/workspaces/:id/merge/bank-shrinks", () => {
  function app() {
    const a = new Hono();
    a.route("/api/workspaces", createWorkspaceMergeBankShrinksRoute(() => ({}) as never, {} as never));
    return a;
  }

  it("banks the last failed job's hint, commits, and re-triggers the merge (202 + jobId)", async () => {
    const job = startMergeJob("ws-1");
    failMergeJob(job.jobId, "ws-1", new Error(RED));
    const res = await app().request("/api/workspaces/ws-1/merge/bank-shrinks", { method: "POST" });
    expect(res.status).toBe(202);
    const body = await res.json() as { applied: unknown[]; committed: string; jobId: string; statusUrl: string };
    expect(body.applied).toHaveLength(2);
    expect(body.committed).toMatch(/^[0-9a-f]{40}$/);
    expect(body.jobId).not.toBe(job.jobId);
    expect(body.statusUrl).toBe("/api/workspaces/ws-1/merge-status");
    expect((await git(["log", "-1", "--format=%s"])).trim()).toBe("test(#1250): bank the nloc shrinks the merge gate named");
    await vi.waitFor(() => expect(mergeWorkspaceDeduped).toHaveBeenCalledWith("ws-1", expect.anything()));
  });

  it("409s while a merge job is running, and 422s when the last verdict carries no hint", async () => {
    startMergeJob("ws-1");
    expect((await app().request("/api/workspaces/ws-1/merge/bank-shrinks", { method: "POST" })).status).toBe(409);
    resetMergeJobs();
    const job = startMergeJob("ws-1");
    failMergeJob(job.jobId, "ws-1", new Error("FAIL src/__tests__/foo.test.ts > expected 1 to be 2"));
    const res = await app().request("/api/workspaces/ws-1/merge/bank-shrinks", { method: "POST" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/nothing to bank/);
    resetMergeJobs();
    expect((await app().request("/api/workspaces/ws-1/merge/bank-shrinks", { method: "POST" })).status).toBe(422);
    expect(mergeWorkspaceDeduped).not.toHaveBeenCalled();
  });

  it("404s for a workspace without a worktree", async () => {
    const job = startMergeJob("ws-1");
    failMergeJob(job.jobId, "ws-1", new Error(RED));
    workspaceRow.current = { id: "ws-1", issueId: "issue-1", workingDir: null };
    expect((await app().request("/api/workspaces/ws-1/merge/bank-shrinks", { method: "POST" })).status).toBe(404);
  });
});
