// @covers agent-providers.strip.profileEnv [config,security]
//
// Cross-profile credential-bleed guard. `buildSpawnEnv` (services/agent-provider/helpers.ts)
// constructs the env a Claude agent is spawned with. The server process itself may hold
// ANTHROPIC_* vars belonging to ONE profile (its own login / a previously-applied profile).
// When a session is launched for a DIFFERENT profile those vars MUST be stripped first, or
// the new agent silently authenticates with the WRONG account (a leak with high blast radius:
// wrong billing, wrong quota, wrong base-url endpoint). This test pollutes process.env with a
// foreign profile's credentials and asserts the built spawn env carries none of them.
//
// SCOPE: this test covers the unconditional STRIP LOOP (helpers.ts:148-150) — the real security
// guard. It does NOT claim the "AUTH_TOKEN set, no API_KEY -> delete ANTHROPIC_API_KEY" branch
// (helpers.ts:161-163), and the @covers above intentionally omits the error-handling dimension
// for that reason. That branch is DEAD CODE: the strip loop already deletes ANTHROPIC_API_KEY
// (it is in PROFILE_OWNED_ENV_VARS) before control reaches :161, and the branch's own guard
// `!profileEnv.ANTHROPIC_API_KEY` only fires when the profile supplies no key — so the later
// Object.assign never re-introduces one either. Under every reachable state the delete at :161
// is a no-op; removing :161-163 leaves all assertions in this file GREEN (verified). A product
// ticket is being filed to confirm + remove that branch.
//
// note: the strip is ALLOWLIST-shaped (a fixed 5-key PROFILE_OWNED_ENV_VARS list), so it misses
// non-ANTHROPIC_ Claude auth vars (e.g. CLAUDE_CODE_OAUTH_TOKEN), which would still bleed across
// profiles. A prefix/denylist strip would be safer — tracked by a separate security ticket (to
// be filed). This test deliberately does NOT assert that unimplemented hardening.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSpawnEnv } from "../services/agent-provider/helpers.js";
import type { FileSystem } from "../services/agent-provider/types.js";

const PROFILE_OWNED = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "API_TIMEOUT_MS",
] as const;

/** A FileSystem fake that serves a single profile settings file's JSON. */
function fakeFsFor(profileName: string, settings: unknown): FileSystem {
  return {
    existsSync: (p: string) => p.includes(`settings_${profileName}.json`),
    readFileSync: (p: string, _enc: BufferEncoding) => {
      if (p.includes(`settings_${profileName}.json`)) return JSON.stringify(settings);
      throw new Error(`unexpected read: ${p}`);
    },
    writeFileSync: () => undefined,
  };
}

/** A FileSystem fake where no profile file exists. */
const noProfileFs: FileSystem = {
  existsSync: () => false,
  readFileSync: () => {
    throw new Error("no files exist");
  },
  writeFileSync: () => undefined,
};

describe("buildSpawnEnv — cross-profile credential-bleed strip", () => {
  // Snapshot only the keys we mutate, so we can restore process.env exactly.
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of PROFILE_OWNED) saved[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of PROFILE_OWNED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("strips the server's own ANTHROPIC_* vars when NO profile is applied (no bleed into a default launch)", () => {
    // The server process is polluted with another profile's live credentials.
    process.env.ANTHROPIC_API_KEY = "sk-foreign-leaked-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "foreign-oauth-token";
    process.env.ANTHROPIC_BASE_URL = "https://foreign.example/anthropic";
    process.env.ANTHROPIC_MODEL = "foreign-model";
    process.env.API_TIMEOUT_MS = "999999";

    const env = buildSpawnEnv(undefined, noProfileFs);

    // None of the foreign profile-owned vars may survive into the spawn env.
    for (const key of PROFILE_OWNED) {
      expect(env[key], `${key} must be stripped`).toBeUndefined();
    }
    // Non-owned vars are passed through unharmed.
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("strips the server's foreign creds before applying the target profile's env (the target's values win, no leak-through)", () => {
    // Server holds profile-A credentials...
    process.env.ANTHROPIC_API_KEY = "sk-profileA-key";
    process.env.ANTHROPIC_BASE_URL = "https://profileA.example/anthropic";
    process.env.ANTHROPIC_MODEL = "profileA-model";

    // ...but we launch for profile-B, which only sets a base-url + model (no key of its own).
    const fs = fakeFsFor("profileB", {
      env: {
        ANTHROPIC_BASE_URL: "https://profileB.example/anthropic",
        ANTHROPIC_MODEL: "profileB-model",
      },
    });

    const env = buildSpawnEnv("profileB", fs);

    // Profile-A's API key must NOT bleed into profile-B's launch.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // Profile-B's own values are what the agent sees.
    expect(env.ANTHROPIC_BASE_URL).toBe("https://profileB.example/anthropic");
    expect(env.ANTHROPIC_MODEL).toBe("profileB-model");
  });

  it("an AUTH_TOKEN-auth profile launch carries no stray server API key, so the token wins cleanly", () => {
    // Server is polluted with a stray API key from some other profile.
    process.env.ANTHROPIC_API_KEY = "sk-stray-key";

    // Target profile authenticates via AUTH_TOKEN and deliberately sets NO API key.
    const fs = fakeFsFor("oauthProfile", {
      env: {
        ANTHROPIC_AUTH_TOKEN: "profile-oauth-token",
        ANTHROPIC_BASE_URL: "https://oauth.example/anthropic",
      },
    });

    const env = buildSpawnEnv("oauthProfile", fs);

    // The stray key is gone, so the SDK uses the profile's token, not the wrong account's key.
    // ATTRIBUTION: this clean outcome is produced by the strip LOOP (:148-150), which already
    // removed ANTHROPIC_API_KEY, NOT by the :161-163 branch (dead — see header). The profile
    // supplies no API_KEY, so Object.assign re-introduces nothing. This case is here for the
    // realistic OAuth-profile workflow, not to assert the dead branch.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("profile-oauth-token");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://oauth.example/anthropic");
  });

  it("keeps the profile's OWN API key when the profile provides one (strip is of the SERVER's vars, not the profile's)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-server-stray";

    const fs = fakeFsFor("keyed", {
      env: { ANTHROPIC_API_KEY: "sk-profile-own-key" },
    });

    const env = buildSpawnEnv("keyed", fs);

    // The stray server key is replaced by the profile's own key (not deleted, since the
    // AUTH_TOKEN-without-key branch does not apply here).
    expect(env.ANTHROPIC_API_KEY).toBe("sk-profile-own-key");
  });
});
