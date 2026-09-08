// @gate:always-run when:scripts/**
// Imports scripts/legacy-temp-prefixes.mjs, which no package-local diff links to (#687), so it
// must not be scoped out BY IMPORT GRAPH. It does not need to run on every diff though, and an
// unconditional marker here is not free: it costs ~3s on EVERY gate run forever, which is what
// `always-run-guard-runtime-ratchet.test.ts` (#1042) exists to price — it caught this one on the
// master sweep, at 561s against a 558s floor.
//
// The RULE this pins lives in `scripts/`, so that is the territory. Residual gap, stated rather
// than hidden: the assertions below also name four `ak-` prefixes minted in `packages/**`
// (smoke-check, cli, compounding-setup, drive-preflight), so renaming one of those without
// touching `scripts/` would not force this suite. The full sweep catches that case — which is
// exactly how this marker's own cost was caught — and paying 3s on every diff to close it is the
// worse trade.
/**
 * #1056 follow-up — `sweep-temp-dirs.mjs --legacy` DELETES by a derived rule, so the derivation
 * is the thing that needs pinning.
 *
 * The claim it makes: for every `ak-<X>-` prefix this repo mints under `tmpdir()` today, the bare
 * `<X>-` form in `%TEMP%` was minted by an OLDER revision of that same call site, and is therefore
 * ours to remove. That is provable about our own history rather than a guess about a name — which
 * is what makes it safe to act on where a hand-written list of "known offenders" would not be
 * (see `temp-dir-namespace-guard.test.ts`'s header on why such lists cannot work).
 *
 * Measured when this landed: 22,704 eligible directories, ~25 % of `%TEMP%`, in families like
 * `smoke-srv-`, `cli-test-`, `compounding-setup-`, `preflight-test-`.
 *
 * The risk this file exists to hold down is OVER-reach in the other direction: a derived prefix
 * generic enough to match a sibling tool's directories. Both halves are asserted — that the
 * derivation still finds real prefixes (a rule matching nothing deletes nothing, but also proves
 * nothing), and that it still declines the generic ones.
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  deriveLegacyPrefixes,
  isClaimablePrefix,
  matchLegacyPrefix,
  MIN_GENERIC_LENGTH,
} from "../../../../scripts/legacy-temp-prefixes.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

describe("legacy temp-prefix derivation (#1056 follow-up)", () => {
  it("claims a specific prefix and declines a generic one", () => {
    for (const p of ["smoke-srv", "cli-test", "compounding-setup", "preflight-test", "zero-diff-ws"]) {
      expect(isClaimablePrefix(p), `${p} is unmistakably ours`).toBe(true);
    }
    // A hyphen-free short word is common enough to belong to any tool on the machine. These are
    // real derivations from this repo — `ak-plan-`, `ak-ws-`, `ak-fork-` all exist — and claiming
    // their bare forms would mean deleting `plan-*` or `ws-*` directories we did not create.
    for (const p of ["plan", "ws", "fork", "guard", "tmp", ""]) {
      expect(isClaimablePrefix(p), `${p} is too generic to claim`).toBe(false);
    }
    // A purely numeric fragment is never a name: it falls out of `ak-<ticket>-something`, and
    // claiming it would match any directory starting with that number.
    for (const p of ["1027", "42", "1000"]) {
      expect(isClaimablePrefix(p), `${p} is a ticket number, not a prefix`).toBe(false);
    }
    // The length rule is a real boundary, not decoration.
    expect(isClaimablePrefix("a".repeat(MIN_GENERIC_LENGTH))).toBe(true);
    expect(isClaimablePrefix("a".repeat(MIN_GENERIC_LENGTH - 1))).toBe(false);
  });

  it("matches both separators mkdtemp call sites have used, and nothing else", () => {
    const prefixes = ["smoke-srv", "cli-test"];
    expect(matchLegacyPrefix("smoke-srv-00QDjs", prefixes)).toBe("smoke-srv");
    expect(matchLegacyPrefix("cli-test_abc123", prefixes)).toBe("cli-test");
    // A LONGER name that merely starts with the same letters is not a match — the separator is
    // what makes it a prefix rather than a coincidence.
    expect(matchLegacyPrefix("smoke-srvXYZ", prefixes)).toBeNull();
    expect(matchLegacyPrefix("smoke-server-1", prefixes)).toBeNull();
    expect(matchLegacyPrefix("unrelated-thing", prefixes)).toBeNull();
  });

  // 300s, not the default 120s: this case walks and reads EVERY source file in the repo, so it
  // is I/O-bound rather than slow, and under a full-suite run (`--maxWorkers=4`) it contends
  // with every other suite for the same disk. Measured ~4s standalone; it timed out at 120s
  // once inside a full run. Raising the budget for the one case that does a whole-tree walk is
  // the honest fix — trimming the walk would weaken what the guard actually checks.
  it("derives real prefixes from the tree — a rule that matches nothing proves nothing", { timeout: 300_000 }, () => {
    const { claimable, rejected } = deriveLegacyPrefixes(REPO_ROOT);
    // Measured at 330 claimable / 24 declined. A floor, not the exact number: this is derived
    // from live sources and moves whenever a fixture is added or renamed.
    expect(claimable.length).toBeGreaterThan(100);
    // The families the drain was actually built for must still be derivable, or the rule has
    // gone dead while continuing to report success.
    for (const p of ["smoke-srv", "cli-test", "compounding-setup", "preflight-test"]) {
      expect(claimable, `${p} must still be derived from the tree`).toContain(p);
    }
    // And the narrowing must still BITE. If `rejected` ever empties, either the generic filter
    // stopped working or the sources stopped producing generic names — and the first would mean
    // this script had quietly started claiming `plan-*` and `ws-*`.
    expect(rejected.length).toBeGreaterThan(0);
    for (const p of rejected) expect(isClaimablePrefix(p)).toBe(false);
    // No claimed prefix may also be rejected, and neither list may contain a namespace the
    // steady-state sweep already owns (that would double-count, or worse, re-derive `ak-` itself).
    for (const p of claimable) {
      expect(rejected).not.toContain(p);
      expect(p.startsWith("ak-"), `${p} must be the BARE form, not the ak- one`).toBe(false);
      expect(p.startsWith("kanban-"), `${p} is already an owned namespace`).toBe(false);
    }
  });
});
