// @covers workspaces.create.branch-create-claim [error]
//
// #1487: a transaction that never settles is reported and failed (watchdog), and a create whose
// phase stops advancing frees its claim so a retry can proceed.
import { describe, it, expect, afterEach, vi } from "vitest";
import { withTransaction, TransactionTimeoutError, listOpenTransactions, type Database } from "../db/index.js";
import {
  claimBranchForCreate, touchBranchCreateClaim, releaseBranchForCreate, resetBranchCreateClaims,
  isBranchCreateClaimed, CLAIM_STALL_MS, CLAIM_DEFAULT_STALL_MS,
} from "../services/workspace-branch-create-claim.js";

const fakeDb = (onTx?: () => void) => ({
  transaction: async (f: (tx: unknown) => Promise<unknown>) => { onTx?.(); return f({}); },
}) as unknown as Database;

afterEach(() => { resetBranchCreateClaims(); vi.restoreAllMocks(); });

describe("withTransaction watchdog", () => {
  it("fails a hung transaction with its label and clears the open registry", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const p = withTransaction(fakeDb(), () => new Promise<void>(() => {}), "workspace create db writes", { timeoutMs: 30 });
    await expect(p).rejects.toBeInstanceOf(TransactionTimeoutError);
    expect(err.mock.calls.flat().join(" ")).toContain("workspace create db writes");
    expect(listOpenTransactions()).toEqual([]);
  });

  it("rolls back (throws) a transaction that unblocks after it was failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let release!: () => void;
    let settled: Promise<unknown> | undefined;
    const db = {
      transaction: (f: (tx: unknown) => Promise<unknown>) => (settled = f({})),
    } as unknown as Database;
    const p = withTransaction(db, () => new Promise<void>((r) => { release = r; }), "late", { timeoutMs: 20 });
    await expect(p).rejects.toBeInstanceOf(TransactionTimeoutError);
    release();
    await expect(settled).rejects.toBeInstanceOf(TransactionTimeoutError);
  });

  it("two concurrent healthy transactions both complete", async () => {
    const run = (n: number) => withTransaction(fakeDb(), async () => { await new Promise((r) => setTimeout(r, 10)); return n; }, `c${n}`);
    expect(await Promise.all([run(1), run(2)])).toEqual([1, 2]);
  });
});

describe("claim stall", () => {
  const T0 = 1_700_000_000_000;
  const target = { repoPath: "/tmp/repo", issueId: "i1", branch: "feature/ak-9-x" };

  it("a create stuck in committing releases its claim to a retry within the TTL", () => {
    const first = claimBranchForCreate(target, { nowMs: T0 })!;
    touchBranchCreateClaim(first, "committing", { nowMs: T0 + 1000 });
    expect(claimBranchForCreate(target, { nowMs: T0 + 60_000 })).toBeNull();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const retry = claimBranchForCreate(target, { nowMs: T0 + 1000 + CLAIM_STALL_MS.committing })!;
    expect(retry).not.toBeNull();
    releaseBranchForCreate(first); // the hung holder waking up must not free the successor's claim
    expect(isBranchCreateClaimed(target, { nowMs: T0 + 1000 + CLAIM_STALL_MS.committing })).toBe(true);
  });

  it("advancing the phase resets the stall clock", () => {
    const first = claimBranchForCreate(target, { nowMs: T0 })!;
    touchBranchCreateClaim(first, "siblings", { nowMs: T0 + CLAIM_DEFAULT_STALL_MS - 1 });
    expect(claimBranchForCreate(target, { nowMs: T0 + CLAIM_DEFAULT_STALL_MS + 1 })).toBeNull();
  });
});
