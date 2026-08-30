import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  const dir = mkdtempSync(join(tmpdir(), "ak-tree-memo-"));
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

  // ---- #958: the SELECTOR component -------------------------------------------------------
  //
  // The hole this closes: `treeHash` covers the impact MAP (it is committed), but not the
  // SELECTOR, which is materialized into the worktree untracked. Bump `impact.mjs` and the
  // selected set changes while tree, tier and verify command are all identical — a pass banked
  // under the narrower old selector replaying under the wider new one.

  it("does not reuse a pass earned under a DIFFERENT selector — the #958 stale green", () => {
    // The ticket's first "done when", stated as the failure it prevents: without the third
    // component both keys are `gateVerificationKey("full", "pnpm verify")` and this reads true.
    const OLD_SELECTOR = gateVerificationKey("full", "pnpm verify", "ti1:0679b6655ff3138c17ba");
    const NEW_SELECTOR = gateVerificationKey("full", "pnpm verify", "ti1:aaaabbbbccccddddeeee");
    rememberTreeGatedGreen("p1", "abc123", OLD_SELECTOR);
    expect(wasTreeGatedGreen("p1", "abc123", NEW_SELECTOR)).toBe(false);
    // ...and is still reusable under the SAME selector, or the component would just be noise.
    expect(wasTreeGatedGreen("p1", "abc123", OLD_SELECTOR)).toBe(true);
  });

  it("a project NOT using the selector keeps the exact key it had before #958", () => {
    // The ticket's second "done when". This is the whole reason absence appends nothing rather
    // than a bare separator: every banked green on every project must survive this change
    // landing. The literal is the pre-#958 hash of `full\0pnpm verify` — if the empty case ever
    // starts contributing bytes, this fails rather than silently invalidating every memo.
    const preChange = createHash("sha256").update("full\0pnpm verify").digest("hex").slice(0, 16);
    expect(gateVerificationKey("full", "pnpm verify")).toBe(preChange);
    expect(gateVerificationKey("full", "pnpm verify", "")).toBe(preChange);
    expect(gateVerificationKey("full", "pnpm verify", null)).toBe(preChange);
  });

  it("a selector id is not confusable with an ordinary verify command", () => {
    // The `selector=` marker keeps the appended field distinguishable from anything a real
    // command can end with, so a project whose verify command merely MENTIONS a selector id
    // does not collide with one that actually pins that selector.
    expect(gateVerificationKey("full", "cmd", "ti1:abcdef01")).not.toBe(gateVerificationKey("full", "cmd ti1:abcdef01"));
    expect(gateVerificationKey("full", "cmd", "ti1:abcdef01")).not.toBe(gateVerificationKey("full", "cmd"));
    expect(gateVerificationKey("full", "cmd", "ti1:abcdef01")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("DOCUMENTS the one accepted collision: a verify command containing a literal NUL", () => {
    // Pinned deliberately rather than left implicit. The encoding is not injective over
    // arbitrary strings, and making it so means length-prefixing every field — which re-keys
    // every project, the exact churn this component must not cause. Reaching this needs a NUL
    // inside `verify_script`, which is a shell command line and cannot carry one.
    //
    // If this test ever fails, the encoding changed: that is fine, but check that the
    // "unchanged key before #958" test above still passes, because it is the one that matters.
    expect(gateVerificationKey("full", "cmd", "ti1:abcdef01")).toBe(
      gateVerificationKey("full", "cmd\0selector=ti1:abcdef01"),
    );
  });

  it("the selector is independent of the tier and the command, not a substitute for either", () => {
    const sel = "ti1:0679b6655ff3138c17ba";
    expect(gateVerificationKey("scoped", "pnpm verify", sel)).not.toBe(gateVerificationKey("full", "pnpm verify", sel));
    expect(gateVerificationKey("full", "pnpm test", sel)).not.toBe(gateVerificationKey("full", "pnpm verify", sel));
  });
});
