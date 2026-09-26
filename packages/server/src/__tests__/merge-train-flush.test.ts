import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import type { RiskPosture } from "@agentic-kanban/shared/types";
import { decideBaseRedVeto } from "../services/merge-train-base-veto.js";
import {
  FLUSH_LEDGER_SOURCE,
  formatFlushMessage,
  formatFlushTag,
  isFlushAllowedForLevel,
  isFlushAllowedForPosture,
  nextFlushSeq,
  runFlushTrain,
} from "../services/merge-train-flush.js";

/**
 * #1247, decision 020 part 2 — flush train mode: no size cap (the caller passes the whole ready
 * set; nothing here caps it), gate = arch+typecheck only (the caller's `runGate`; this module
 * never invents its own), no bisect arm, siding stays active (unchanged `runMergeTrain`
 * machinery), landing tagged `flush/<date>-N`, ledger `source: flush`, refusal under
 * strict/standard, and the base-red veto never holds a flush.
 */

// ── refusal by posture (item 5) ─────────────────────────────────────────────────────────

describe("isFlushAllowedForLevel / isFlushAllowedForPosture (#1247)", () => {
  it("refuses strict and standard — both promise a green master", () => {
    expect(isFlushAllowedForLevel("strict")).not.toBeNull();
    expect(isFlushAllowedForLevel("standard")).not.toBeNull();
    expect(isFlushAllowedForLevel("strict")?.reason).toContain("strict");
  });

  it("allows fast, sprint, iterate and flow", () => {
    for (const level of ["fast", "sprint", "iterate", "flow"] as const) {
      expect(isFlushAllowedForLevel(level)).toBeNull();
    }
  });

  it("reads the level off a resolved posture", () => {
    const posture = { level: "standard" } as RiskPosture;
    expect(isFlushAllowedForPosture(posture)).not.toBeNull();
    expect(isFlushAllowedForPosture({ ...posture, level: "flow" })).toBeNull();
  });
});

// ── the veto never holds a flush (item 5, second half) ──────────────────────────────────

describe("the base-red veto does not hold a flush (#1247)", () => {
  it("every flush-eligible posture resolves a non-block redBasePolicy, so decideBaseRedVeto is always null", () => {
    // fast -> allow-known-debt, sprint -> allow-file-debt-ticket, iterate -> allow-file-debt-ticket,
    // flow -> report — none is `block`, so a flush never has to special-case the veto: it is
    // already soft for every posture flush is allowed under, by construction.
    for (const redBasePolicy of ["allow-known-debt", "allow-file-debt-ticket", "report"] as const) {
      expect(
        decideBaseRedVeto({ outcome: "red", healthSha: "deadbeef", baseAheadOfHealthSha: false, redBasePolicy }, "4 suites failed"),
      ).toBeNull();
    }
  });
});

// ── tag/message/ledger helpers (items 3-4) ───────────────────────────────────────────────

describe("formatFlushTag / nextFlushSeq (#1247)", () => {
  it("formats flush/<date>-N", () => {
    expect(formatFlushTag("2026-09-26", 1)).toBe("flush/2026-09-26-1");
    expect(formatFlushTag("2026-09-26", 3)).toBe("flush/2026-09-26-3");
  });

  it("nextFlushSeq starts at 1 with no prior tags for the day", () => {
    expect(nextFlushSeq("2026-09-26", [])).toBe(1);
    expect(nextFlushSeq("2026-09-26", ["train/2026-09-26-01", "stable-2026-09-26"])).toBe(1);
  });

  it("nextFlushSeq continues the SAME day's sequence, ignoring other days and other tag kinds", () => {
    expect(nextFlushSeq("2026-09-26", ["flush/2026-09-26-1", "flush/2026-09-26-2", "flush/2026-09-25-9"])).toBe(3);
  });
});

describe("formatFlushMessage (#1247)", () => {
  it("never reads as a bare 'passed' — names the mode, the count, the gate and the heal target", () => {
    const msg = formatFlushMessage({ landedCount: 5, healTarget: "rc/2026-09-26" });
    expect(msg).toBe("FLUSH: 5 branches landed, gate = arch + typecheck, suite deferred to rc/2026-09-26");
  });
});

describe("FLUSH_LEDGER_SOURCE (#1247, #1234)", () => {
  it("is the literal 'flush' — the miss-rate join separates it from ordinary impact-selection misses", () => {
    expect(FLUSH_LEDGER_SOURCE).toBe("flush");
  });
});

// ── runFlushTrain against a real repo: no cap, no bisect, tag, siding for a conflicting member ──

let repo: string;
const git = (args: string[]) => gitExecOrThrow(args, { cwd: repo });

async function commitFile(branch: string, file: string, content: string, from = "main") {
  await git(["checkout", "-q", "-b", branch, from]);
  writeFileSync(join(repo, file), content, "utf8");
  await git(["add", file]);
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `feat: ${file}`]);
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "kanban-flush-train-"));
  await git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
  writeFileSync(join(repo, "shared.txt"), "shared\n", "utf8");
  await git(["add", "."]);
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chore: base"]);
});

afterEach(() => {
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

const memberList = (ids: string[]) => ids.map((id, i) => ({ workspaceId: `w${i + 1}`, branch: id, issueNumber: i + 1 }));

describe("runFlushTrain (#1247)", () => {
  it("lands a train of 6 with one conflicting member sided, runs the gate ONCE, no bisect, tags the landing", async () => {
    const branches = ["f1", "f2", "f3", "f4", "f5", "f6"];
    for (const b of branches) await commitFile(b, `${b}.txt`, b);
    // f6 conflicts with the base itself (both touch shared.txt differently) — dropped, not landed.
    await git(["checkout", "-q", "f6"]);
    writeFileSync(join(repo, "shared.txt"), "f6 changed shared\n", "utf8");
    await git(["add", "shared.txt"]);
    await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feat: touch shared too"]);
    await git(["checkout", "-q", "main"]);
    writeFileSync(join(repo, "shared.txt"), "main changed shared\n", "utf8");
    await git(["add", "shared.txt"]);
    await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chore: also touch shared on main"]);

    const runGate = vi.fn().mockResolvedValue({ passed: true, message: "arch + typecheck passed" });
    const closeMember = vi.fn().mockResolvedValue(undefined);

    const result = await runFlushTrain({
      repoPath: repo,
      baseBranch: "main",
      members: memberList(branches),
      label: "flush-t1",
      runGate,
      closeMember,
      healTarget: "master",
      existingFlushTags: [],
    });

    // ONE gate run for the whole batch — no size cap, no bisect re-gating.
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(result.run.gateRuns).toBe(1);
    expect(result.run.landed.length).toBe(5);
    expect(result.run.dropped.some((d) => d.member.branch === "f6")).toBe(true);
    expect(result.run.mergeSha).toBeTruthy();
    expect(result.tag).toBe("flush/" + result.tag!.split("/")[1]);
    expect(result.tag).toMatch(/^flush\/\d{4}-\d{2}-\d{2}-1$/);
    expect(result.message).toBe("FLUSH: 5 branches landed, gate = arch + typecheck, suite deferred to master");
    expect(result.ledgerSource).toBe("flush");

    // The tag actually exists at the landed sha.
    const tagSha = (await gitExecOrThrow(["rev-list", "-n", "1", result.tag!], { cwd: repo })).trim();
    expect(tagSha).toBe(result.run.mergeSha);
  });

  it("a red gate rejects the whole batch attribution-free — no bisect, no gateRejected members", async () => {
    const branches = ["g1", "g2", "g3"];
    for (const b of branches) await commitFile(b, `${b}.txt`, b);

    const runGate = vi.fn().mockResolvedValue({ passed: false, message: "typecheck failed" });
    const closeMember = vi.fn().mockResolvedValue(undefined);

    const result = await runFlushTrain({
      repoPath: repo,
      baseBranch: "main",
      members: memberList(branches),
      label: "flush-t2",
      runGate,
      closeMember,
      healTarget: "master",
      existingFlushTags: [],
    });

    // No bisect: exactly one gate run for the whole batch, never split.
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(result.run.gateRuns).toBe(1);
    expect(result.run.landed).toEqual([]);
    expect(result.run.gateRejected).toEqual([]);
    expect(result.tag).toBeUndefined();
    expect(result.message).toBe("FLUSH: 0 branches landed, gate = arch + typecheck, suite deferred to master");
  });

  it("continues the SAME day's flush tag sequence when one already exists", async () => {
    await commitFile("h1", "h1.txt", "h1");
    const runGate = vi.fn().mockResolvedValue({ passed: true, message: "ok" });
    const closeMember = vi.fn().mockResolvedValue(undefined);
    const today = new Date().toISOString().slice(0, 10);

    const result = await runFlushTrain({
      repoPath: repo,
      baseBranch: "main",
      members: memberList(["h1"]),
      label: "flush-t3",
      runGate,
      closeMember,
      healTarget: "master",
      existingFlushTags: [`flush/${today}-1`],
    });

    expect(result.tag).toBe(`flush/${today}-2`);
  });
});
