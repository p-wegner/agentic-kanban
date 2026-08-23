// @gate:always-run — this suite's subject, scripts/security-scan.mjs, lives at the
// repo root and belongs to no package, so package-scoped test selection cannot map a
// change in it back to this file. It is a pure policy assertion and runs in ~1s.
import { describe, expect, it } from "vitest";

import { POLICY, matchAny } from "../../../scripts/security-scan.mjs";

/**
 * The licence half of the dependency scan (#741) used to be a NUMBER: at most two
 * production packages could ship no readable SPDX id. That is the wrong unit, and
 * it failed in production on 2026-08-23 — the Anthropic Claude Agent SDK ships one
 * package per platform, `-linux-x64-musl` appeared, the count went 2 -> 3, and CI
 * went red over our own dependency growing a build target rather than over any
 * change in who we depend on or under what terms.
 *
 * It was also weak in the other direction: a ceiling of N says "N unknowns are
 * acceptable" without saying WHICH, so dropping a known unknown silently leaves
 * room for an unrelated supplier to arrive underneath it.
 *
 * So acceptance is by NAME now, and this suite is what stops the name list
 * quietly becoming as permissive as the count was. It asserts on the policy
 * object directly rather than running a scan: `pnpm security` shells out to pnpm
 * twice and takes ~3s, and — more to the point — its result depends on which
 * PLATFORM it runs on (a Windows laptop sees `win32-x64`, CI sees the two linux
 * builds), so a test that ran the real scan could not check the names that
 * actually broke CI.
 */
describe("accepted-unknown-licence patterns (production graph)", () => {
  const accepted = POLICY.licences.acceptedProdUnknownLicences;

  it("no longer carries the numeric ceiling it replaced", () => {
    expect(
      POLICY.licences.prodUnknownCeiling,
      "prodUnknownCeiling is back. A count cannot say WHICH unknown licences are " +
        "known, which is the whole reason it was replaced — see docs/security-policy.md.",
    ).toBeUndefined();
    expect(Array.isArray(accepted)).toBe(true);
    expect(accepted.length).toBeGreaterThan(0);
  });

  it("accepts the SDK family on every platform, including the two that broke CI", () => {
    // The first two are exactly what the 2026-08-23 CI failure listed; the rest
    // are platforms the SDK can add next. A regression here is a red CI on a
    // machine nobody is sitting at.
    const platformVariants = [
      "@anthropic-ai/claude-agent-sdk@0.3.152",
      "@anthropic-ai/claude-agent-sdk-linux-x64@0.3.152",
      "@anthropic-ai/claude-agent-sdk-linux-x64-musl@0.3.152",
      "@anthropic-ai/claude-agent-sdk-win32-x64@0.3.152",
      "@anthropic-ai/claude-agent-sdk-darwin-arm64@0.4.0",
    ];
    const rejected = platformVariants.filter((pkg) => !matchAny(accepted, pkg));
    expect(
      rejected,
      "These are the same deliberately-depended-on SDK, one package per platform:\n" +
        rejected.join("\n"),
    ).toEqual([]);
  });

  it("does NOT accept a package merely because it looks adjacent to the SDK", () => {
    // The bite. An acceptance broad enough to cover every platform variant is
    // broad enough to be sloppy, and these are the three ways it goes wrong:
    // a different package in the same scope, the same name in someone ELSE's
    // scope (the supply-chain case that matters), and a name that merely starts
    // with ours.
    const mustNotMatch = [
      "@anthropic-ai/some-other-package@1.0.0",
      "@evil/claude-agent-sdk@1.0.0",
      "@anthropic-ai/claude-agent-sdkextra@1.0.0",
      "claude-agent-sdk@1.0.0",
      "left-pad@1.0.0",
    ];
    const leaked = mustNotMatch.filter((pkg) => matchAny(accepted, pkg));
    expect(
      leaked,
      "An unknown-licence package with no relationship to the accepted SDK is " +
        "being waved through:\n" + leaked.join("\n"),
    ).toEqual([]);
  });

  it("anchors every pattern at both ends so a substring match cannot accept a package", () => {
    // `/claude-agent-sdk/` with no anchors would match any name CONTAINING it,
    // which is how a name list decays into a count.
    for (const re of accepted) {
      expect(re.source.startsWith("^"), `${re} is not anchored at the start`).toBe(true);
      expect(
        re.source.endsWith("@"),
        `${re} does not end at the name/version boundary '@', so it can match a ` +
          "longer package name than intended",
      ).toBe(true);
    }
  });
});
