import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetTreeGateMemoForTests,
  gateVerificationKey,
  mergedTreeHash,
  rememberTreeGatedGreen,
  wasTreeGatedGreen,
} from "../services/merge-gate-tree-memo.js";

/**
 * Reuse a gate PASS across an identical merged tree (#492, item 2).
 *
 * The measured waste: five ready branches cost five ~42-min suite runs, mostly re-running the
 * same tests against the same code — and a rebase that changed no content re-gated from
 * scratch, because a new commit id looks like new work when the TREE is identical.
 */
const roots: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tree-memo-"));
  roots.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "t@t.local");
  git("config", "user.name", "T");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-m", "base");
  return dir;
}

afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

describe("mergedTreeHash", () => {
  it("returns a tree id for a real merge", async () => {
    const dir = makeRepo();
    const hash = await mergedTreeHash(dir, "main");
    expect(hash).toMatch(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
  });

  it("gives the SAME tree for two branches whose content is identical", async () => {
    // The property the whole memo rests on: a tree id is content, not history. Two branches
    // that produce the same files must be indistinguishable to the gate.
    const dir = makeRepo();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("checkout", "-b", "one");
    writeFileSync(join(dir, "b.txt"), "two\n");
    git("add", "-A");
    git("commit", "-m", "add b");
    const first = await mergedTreeHash(dir, "main");

    // A different branch, different commit, different message — same resulting files.
    git("checkout", "main");
    git("checkout", "-b", "two");
    writeFileSync(join(dir, "b.txt"), "two\n");
    git("add", "-A");
    git("commit", "-m", "a completely different commit message");
    const second = await mergedTreeHash(dir, "main");

    expect(second).toBe(first);
  });

  it("returns null rather than a hash when it cannot tell", async () => {
    // Null must always mean "do not memoize" — never "skip the gate".
    expect(await mergedTreeHash(null, "main")).toBeNull();
    expect(await mergedTreeHash(makeRepo(), null)).toBeNull();
    expect(await mergedTreeHash(makeRepo(), "no-such-branch")).toBeNull();
  });
});

describe("tree gate memo", () => {
  beforeEach(__resetTreeGateMemoForTests);

  /** The verification a pass was earned under — see `gateVerificationKey`. */
  const FULL = gateVerificationKey("full", "pnpm verify");
  const SCOPED = gateVerificationKey("scoped", "pnpm verify");

  it("reports a remembered tree as already green", () => {
    rememberTreeGatedGreen("p1", "abc123", FULL);
    expect(wasTreeGatedGreen("p1", "abc123", FULL)).toBe(true);
  });

  it("is scoped per project — the same tree is gated by different verify scripts", () => {
    rememberTreeGatedGreen("p1", "abc123", FULL);
    expect(wasTreeGatedGreen("p2", "abc123", FULL)).toBe(false);
  });

  it("never treats a null hash as green", () => {
    // The failure that would matter: an unknown tree reading as verified.
    rememberTreeGatedGreen("p1", null, FULL);
    expect(wasTreeGatedGreen("p1", null, FULL)).toBe(false);
  });

  it("an unrecorded tree is not green", () => {
    expect(wasTreeGatedGreen("p1", "never-seen", FULL)).toBe(false);
  });

  // The hole this closes: the memo was keyed on project + tree only, and consulted BEFORE the
  // tier and the verify command resolved. So a pass banked under `scoped` was replayed for up
  // to the 2h TTL after an operator switched the project to `full` — a level weakening
  // verification invisibly, which the tier rules forbid outright.
  it("does not reuse a pass earned under a WEAKER tier", () => {
    rememberTreeGatedGreen("p1", "abc123", SCOPED);
    expect(wasTreeGatedGreen("p1", "abc123", FULL)).toBe(false);
  });

  it("does not reuse a pass earned under a DIFFERENT verify command", () => {
    rememberTreeGatedGreen("p1", "abc123", gateVerificationKey("full", "pnpm test"));
    expect(wasTreeGatedGreen("p1", "abc123", gateVerificationKey("full", "pnpm test && pnpm lint"))).toBe(false);
  });

  it("a command containing the key separator cannot forge another key", () => {
    // Hashed rather than concatenated, so a `:` in a verify command cannot shift the key's
    // field boundaries into another project's or another tier's slot.
    expect(gateVerificationKey("full", "a:b")).not.toBe(gateVerificationKey("full", "a"));
    expect(gateVerificationKey("full", "x")).toMatch(/^[0-9a-f]{16}$/);
  });
});
