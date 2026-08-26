/**
 * Per-project required data-handling tags (#876), exercised through
 * `resolveProjectRuntimeConfig` — the same seam `project-profile-allowlist.test.ts` uses
 * for the allowlist. A project can require a profile to carry tags like "no-training" or
 * "eu-data-residency"; the profile itself declares what it carries via
 * `profile_capabilities_<provider:name>`. The pure parse/check logic is covered in
 * `packages/shared/__tests__/profile-capabilities.test.ts`; this pins the wiring — that
 * the requirement is read for the RESOLVED profile (after any allowlist clamp), and that
 * it degrades to a hold rather than silently launching an untagged profile.
 */
import { describe, expect, it } from "vitest";
import { profileCapabilitiesPrefKey, requiredDataLabelsPrefKey } from "@agentic-kanban/shared/lib/profile-capabilities";
import { allowedProfilesPrefKey, resolveProjectRuntimeConfig } from "../services/project-runtime-config.service.js";

const PROJECT_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_PROJECT = "99999999-8888-7777-6666-555555555555";

function prefs(entries: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries({ provider: "claude", ...entries }));
}

function resolve(prefMap: Map<string, string>, input: Partial<Parameters<typeof resolveProjectRuntimeConfig>[0]> = {}) {
  return resolveProjectRuntimeConfig({
    projectId: PROJECT_ID,
    prefMap,
    ...input,
  });
}

describe("per-project required data-handling tags", () => {
  it("leaves an unrestricted project exactly as it was", () => {
    const runtime = resolve(prefs({ claude_profile: "whatever" }));
    expect(runtime.provider.dataHandlingHold).toBeNull();
  });

  it("passes when the resolved profile carries the required tag", () => {
    const runtime = resolve(prefs({
      claude_profile: "andrena_team_5x_2",
      [requiredDataLabelsPrefKey(PROJECT_ID)]: "no-training",
      [profileCapabilitiesPrefKey("claude", "andrena_team_5x_2")]: "no-training,eu-data-residency",
    }));
    expect(runtime.provider.dataHandlingHold).toBeNull();
  });

  it("holds when the resolved profile is missing the required tag", () => {
    const runtime = resolve(prefs({
      claude_profile: "personal_account",
      [requiredDataLabelsPrefKey(PROJECT_ID)]: "no-training",
    }));
    expect(runtime.provider.dataHandlingHold).toContain("no-training");
  });

  it("holds when the profile carries no tags at all — untagged is not assumed compliant", () => {
    const runtime = resolve(prefs({
      claude_profile: "andrena_team_5x_2",
      [requiredDataLabelsPrefKey(PROJECT_ID)]: "eu-data-residency",
    }));
    expect(runtime.provider.dataHandlingHold).toContain("eu-data-residency");
  });

  it("checks the tag against the ALLOWLIST-CLAMPED profile, not the requested one", () => {
    // The allowlist pins the project onto andrena_team_5x_2 regardless of what was asked
    // for; the data-handling check must follow that clamp, not the pre-clamp request.
    const runtime = resolve(prefs({
      claude_profile: "personal_account",
      [allowedProfilesPrefKey(PROJECT_ID)]: JSON.stringify([{ provider: "claude", name: "andrena_team_5x_2" }]),
      [requiredDataLabelsPrefKey(PROJECT_ID)]: "no-training",
      [profileCapabilitiesPrefKey("claude", "andrena_team_5x_2")]: "no-training",
      [profileCapabilitiesPrefKey("claude", "personal_account")]: "",
    }));
    expect(runtime.provider.profileName).toBe("andrena_team_5x_2");
    expect(runtime.provider.dataHandlingHold).toBeNull();
  });

  it("another project's required tags do not restrict this one", () => {
    const runtime = resolve(prefs({
      claude_profile: "personal_account",
      [requiredDataLabelsPrefKey(OTHER_PROJECT)]: "no-training",
    }));
    expect(runtime.provider.dataHandlingHold).toBeNull();
  });

  it("does not double-report when the allowlist already holds", () => {
    // An allowlist hold already refuses the launch; the data-handling check has no
    // resolved profile to check against and must not pile on a second, misleading reason.
    const runtime = resolve(prefs({
      claude_profile: "andrena_team_5x_2",
      claude_cooldown_andrena_team_5x_2: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      [allowedProfilesPrefKey(PROJECT_ID)]: JSON.stringify([{ provider: "claude", name: "andrena_team_5x_2" }]),
      [requiredDataLabelsPrefKey(PROJECT_ID)]: "no-training",
    }));
    expect(runtime.provider.profileHold).toContain("cooling");
    expect(runtime.provider.dataHandlingHold).toBeNull();
  });
});
