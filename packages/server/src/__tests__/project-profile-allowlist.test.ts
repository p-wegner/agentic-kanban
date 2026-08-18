/**
 * The per-project profile allowlist, exercised through `resolveProjectRuntimeConfig` —
 * i.e. the seam every launch path actually goes through, not the pure clamp in isolation
 * (that is covered by `packages/shared/__tests__/profile-allowlist.test.ts`).
 *
 * The behaviours worth pinning here are the ones a future refactor of the precedence
 * chain could silently break: that the allowlist outranks an EXPLICIT per-workspace
 * override and the Strategy Bullseye, that a global rotation of `claude_profile` cannot
 * drag a restricted project along, and that exhaustion HOLDS instead of falling back.
 */
import { describe, expect, it } from "vitest";
import {
  allowedProfilesPrefKey,
  resolveProjectRuntimeConfig,
} from "../services/project-runtime-config.service.js";

const PROJECT_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_PROJECT = "99999999-8888-7777-6666-555555555555";
const NOW_MS = Date.parse("2026-08-18T09:00:00.000Z");
const COOLING = new Date(NOW_MS + 60 * 60 * 1000).toISOString();

const PINNED = JSON.stringify([{ provider: "claude", name: "andrena_team_5x_2" }]);

function prefs(entries: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries({ provider: "claude", ...entries }));
}

function resolve(prefMap: Map<string, string>, input: Partial<Parameters<typeof resolveProjectRuntimeConfig>[0]> = {}) {
  return resolveProjectRuntimeConfig({
    projectId: PROJECT_ID,
    prefMap,
    nowMs: NOW_MS,
    ...input,
  });
}

describe("per-project profile allowlist", () => {
  it("leaves an unrestricted project exactly as it was", () => {
    const runtime = resolve(prefs({ claude_profile: "whatever" }));
    expect(runtime.provider.allowlist.restricted).toBe(false);
    expect(runtime.provider.profileName).toBe("whatever");
    expect(runtime.provider.profileClamped).toBe(false);
    expect(runtime.provider.profileHold).toBeNull();
  });

  it("clamps the board default onto the allowed profile", () => {
    const runtime = resolve(prefs({
      claude_profile: "personal_account",
      [allowedProfilesPrefKey(PROJECT_ID)]: PINNED,
    }));
    expect(runtime.provider.profileName).toBe("andrena_team_5x_2");
    expect(runtime.provider.profileClamped).toBe(true);
    expect(runtime.provider.notes.join(" ")).toContain("not allowed");
  });

  it("outranks an EXPLICIT per-workspace profile override", () => {
    // The override is the highest-priority *selector*; the allowlist is a constraint, so
    // it must still win. Without this, anyone launching from the dialog could pick the
    // wrong subscription for a restricted project.
    const runtime = resolve(
      prefs({ [allowedProfilesPrefKey(PROJECT_ID)]: PINNED }),
      { profileOverride: { provider: "claude", name: "personal_account" } },
    );
    expect(runtime.provider.profileName).toBe("andrena_team_5x_2");
    expect(runtime.provider.profileClamped).toBe(true);
  });

  it("outranks the legacy claudeProfile override", () => {
    const runtime = resolve(
      prefs({ [allowedProfilesPrefKey(PROJECT_ID)]: PINNED }),
      { legacyProfileOverride: "personal_account" },
    );
    expect(runtime.provider.profileName).toBe("andrena_team_5x_2");
    expect(runtime.provider.profileClamped).toBe(true);
  });

  it("outranks the Strategy Bullseye selection", () => {
    const runtime = resolve(
      prefs({ [allowedProfilesPrefKey(PROJECT_ID)]: PINNED }),
      { strategySelection: { provider: "codex", profileName: "work" } },
    );
    expect(runtime.provider.provider).toBe("claude");
    expect(runtime.provider.profileName).toBe("andrena_team_5x_2");
    expect(runtime.provider.profileClamped).toBe(true);
  });

  it("outranks a workspace's baked-in selection on relaunch", () => {
    const runtime = resolve(
      prefs({ [allowedProfilesPrefKey(PROJECT_ID)]: PINNED }),
      { workspaceSelection: { provider: "claude", profileName: "personal_account" } },
    );
    expect(runtime.provider.profileName).toBe("andrena_team_5x_2");
  });

  it("a global rotation of claude_profile cannot drag a restricted project along", () => {
    // rotateClaudeSubscription writes the GLOBAL claude_profile pref, so before this
    // constraint existed any project's rate limit moved every project's next launch.
    const runtime = resolve(prefs({
      claude_profile: "rotated_onto_this",
      [allowedProfilesPrefKey(PROJECT_ID)]: PINNED,
    }));
    expect(runtime.provider.profileName).toBe("andrena_team_5x_2");
  });

  it("another project's allowlist does not restrict this one", () => {
    const runtime = resolve(prefs({
      claude_profile: "personal_account",
      [allowedProfilesPrefKey(OTHER_PROJECT)]: PINNED,
    }));
    expect(runtime.provider.allowlist.restricted).toBe(false);
    expect(runtime.provider.profileName).toBe("personal_account");
  });

  it("rotates within the allowlist when the first entry is cooling", () => {
    const runtime = resolve(prefs({
      claude_profile: "a",
      claude_cooldown_a: COOLING,
      [allowedProfilesPrefKey(PROJECT_ID)]: JSON.stringify([
        { provider: "claude", name: "a" },
        { provider: "claude", name: "b" },
      ]),
    }));
    expect(runtime.provider.profileName).toBe("b");
    expect(runtime.provider.profileHold).toBeNull();
  });

  it("HOLDS when the only allowed profile is cooling", () => {
    const runtime = resolve(prefs({
      claude_profile: "andrena_team_5x_2",
      claude_cooldown_andrena_team_5x_2: COOLING,
      [allowedProfilesPrefKey(PROJECT_ID)]: PINNED,
    }));
    expect(runtime.provider.profileHold).toContain("every allowed profile is cooling");
  });

  it("HOLDS on a malformed allowlist instead of running unrestricted", () => {
    const runtime = resolve(prefs({
      claude_profile: "personal_account",
      [allowedProfilesPrefKey(PROJECT_ID)]: "[oops",
    }));
    expect(runtime.provider.allowlist.malformed).toBe(true);
    expect(runtime.provider.profileHold).toContain("unparseable");
  });

  it("passes an already-allowed selection through without a note", () => {
    const runtime = resolve(prefs({
      claude_profile: "andrena_team_5x_2",
      [allowedProfilesPrefKey(PROJECT_ID)]: PINNED,
    }));
    expect(runtime.provider.profileName).toBe("andrena_team_5x_2");
    expect(runtime.provider.profileClamped).toBe(false);
    expect(runtime.provider.profileHold).toBeNull();
    expect(runtime.provider.notes.filter((n) => n.includes("allowlist"))).toEqual([]);
  });

  it("resolves the clamped provider's command line, not the rejected provider's", () => {
    // Patching only the profile name would leave a codex agent_command paired with a
    // claude profile. The resolver re-reads settings after clamping for this reason.
    const runtime = resolve(
      prefs({
        [allowedProfilesPrefKey(PROJECT_ID)]: PINNED,
      }),
      { profileOverride: { provider: "codex", name: "work" } },
    );
    expect(runtime.provider.provider).toBe("claude");
    expect(runtime.provider.profileSelection).toEqual({ provider: "claude", name: "andrena_team_5x_2" });
  });
});
