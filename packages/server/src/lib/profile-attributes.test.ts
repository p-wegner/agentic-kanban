import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PROFILE_ROLE,
  PROFILE_DEDICATED_ENV_KEY,
  PROFILE_ROLE_ENV_KEY,
  defaultProfileAttributes,
  isProfileRole,
  mergeProfileObservations,
  profileAttributeCarrierPaths,
  readProfileAttributes,
  readProfileAttributesFromEnv,
  readProfileAttributesFromToml,
} from "./profile-attributes.js";

/**
 * #1024 — the one reader for `KANBAN_PROFILE_ROLE` / `KANBAN_PROFILE_DEDICATED`,
 * across all three carriers, plus the "forbidden wins" conflict rule.
 */

const NOW = "2026-09-04T10:00:00.000Z";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "profile-attrs-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function writeText(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
}

describe("readProfileAttributesFromEnv", () => {
  it("reads role and dedication out of a settings env block", () => {
    const obs = readProfileAttributesFromEnv(
      { [PROFILE_ROLE_ENV_KEY]: "reserve", [PROFILE_DEDICATED_ENV_KEY]: "kunde-x" },
      "src",
      NOW,
    );
    expect(obs).toEqual({ source: "src", role: "reserve", dedicatedProject: "kunde-x", observedAt: NOW });
  });

  it("is silence (null) when neither key is present — an absent key is not an observation", () => {
    expect(readProfileAttributesFromEnv({ ANTHROPIC_API_KEY: "x" }, "src", NOW)).toBeNull();
    expect(readProfileAttributesFromEnv(undefined, "src", NOW)).toBeNull();
    expect(readProfileAttributesFromEnv([], "src", NOW)).toBeNull();
  });

  it("degrades an unknown role to pool and reports it, instead of throwing", () => {
    const obs = readProfileAttributesFromEnv({ [PROFILE_ROLE_ENV_KEY]: "banned" }, "src", NOW);
    expect(obs?.role).toBe("pool");
    expect(obs?.unknownRole).toBe("banned");
    const merged = mergeProfileObservations([obs]);
    expect(merged.role).toBe("pool");
    expect(merged.warnings.join(" ")).toContain("banned");
  });

  it("accepts a dedication with no role — role then defaults to pool", () => {
    const obs = readProfileAttributesFromEnv({ [PROFILE_DEDICATED_ENV_KEY]: "kunde-x" }, "src", NOW);
    expect(obs?.role).toBe(DEFAULT_PROFILE_ROLE);
    expect(obs?.dedicatedProject).toBe("kunde-x");
  });
});

describe("readProfileAttributesFromToml (Codex carrier)", () => {
  it("reads the [kanban] table", () => {
    const obs = readProfileAttributesFromToml(
      ['model = "gpt-5"', "", "[kanban]", 'role = "forbidden"', "dedicated = 'training-only'", ""].join("\n"),
      "toml",
      NOW,
    );
    expect(obs).toEqual({ source: "toml", role: "forbidden", dedicatedProject: "training-only", observedAt: NOW });
  });

  it("ignores keys outside the [kanban] table", () => {
    const obs = readProfileAttributesFromToml(
      ["[kanban]", 'role = "reserve"', "", "[profiles.other]", 'role = "forbidden"'].join("\n"),
      "toml",
      NOW,
    );
    expect(obs?.role).toBe("reserve");
  });

  it("accepts the env-style key names as aliases and strips trailing comments", () => {
    const obs = readProfileAttributesFromToml(
      ["# a comment", "[kanban]", `${PROFILE_ROLE_ENV_KEY} = reserve # emergency only`].join("\n"),
      "toml",
      NOW,
    );
    expect(obs?.role).toBe("reserve");
  });

  it("is silence for a TOML with no [kanban] table", () => {
    expect(readProfileAttributesFromToml('model = "gpt-5"\n', "toml", NOW)).toBeNull();
  });
});

describe("readProfileAttributes — carriers on disk", () => {
  it("carrier 1: a Claude API-key profile (~/.claude/settings_<name>.json)", () => {
    writeJson(join(home, ".claude", "settings_anth.json"), {
      env: { [PROFILE_ROLE_ENV_KEY]: "forbidden" },
    });
    const attrs = readProfileAttributes("claude", "anth", { home, now: NOW });
    expect(attrs.role).toBe("forbidden");
    expect(attrs.observedAt).toBe(NOW);
    expect(attrs.roleConflict).toBe(false);
    expect(attrs.sources).toHaveLength(1);
  });

  it("carrier 2: a Claude directory profile (~/.claude-<name>/settings.json)", () => {
    writeJson(join(home, ".claude-privat", "settings.json"), {
      env: { [PROFILE_ROLE_ENV_KEY]: "reserve", [PROFILE_DEDICATED_ENV_KEY]: "privat" },
    });
    const attrs = readProfileAttributes("claude", "privat", { home, now: NOW });
    expect(attrs.role).toBe("reserve");
    expect(attrs.dedicatedProject).toBe("privat");
  });

  it("carrier 3: a Codex profile TOML (~/.codex/<name>.config.toml)", () => {
    writeText(join(home, ".codex", "work.config.toml"), '[kanban]\nrole = "forbidden"\n');
    expect(readProfileAttributes("codex", "work", { home, now: NOW }).role).toBe("forbidden");
  });

  it("also finds the legacy config_<name>.toml and the ~/.codex-<name> dir", () => {
    writeText(join(home, ".codex", "config_legacy.toml"), '[kanban]\nrole = "reserve"\n');
    expect(readProfileAttributes("codex", "legacy", { home, now: NOW }).role).toBe("reserve");

    writeText(join(home, ".codex-oauth", "config.toml"), '[kanban]\nrole = "forbidden"\n');
    expect(readProfileAttributes("codex", "oauth", { home, now: NOW }).role).toBe("forbidden");
  });

  it("a profile with no key anywhere is pool, with no observation stamp", () => {
    writeJson(join(home, ".claude", "settings_plain.json"), { env: { ANTHROPIC_API_KEY: "x" } });
    const attrs = readProfileAttributes("claude", "plain", { home, now: NOW });
    expect(attrs).toEqual(defaultProfileAttributes());
    expect(attrs.role).toBe("pool");
    expect(attrs.observedAt).toBeNull();
  });

  it("an entirely unknown profile is pool, not an error", () => {
    expect(readProfileAttributes("claude", "nope", { home, now: NOW }).role).toBe("pool");
    expect(readProfileAttributes("codex", "nope", { home, now: NOW }).role).toBe("pool");
  });

  it("malformed JSON is silence, not a crash", () => {
    writeText(join(home, ".claude", "settings_broken.json"), "{ not json");
    expect(readProfileAttributes("claude", "broken", { home, now: NOW }).role).toBe("pool");
  });

  it("names the carrier files it looks at", () => {
    expect(profileAttributeCarrierPaths("claude", "anth", home)).toEqual([
      join(home, ".claude", "settings_anth.json"),
      join(home, ".claude-anth", "settings.json"),
    ]);
    expect(profileAttributeCarrierPaths("codex", "anth", home)).toHaveLength(3);
    expect(profileAttributeCarrierPaths("claude", "  ", home)).toEqual([]);
  });
});

describe("conflict rule — forbidden wins and the disagreement is exposed", () => {
  it("two carriers for one profile name disagreeing resolve to forbidden", () => {
    writeJson(join(home, ".claude", "settings_dual.json"), { env: { [PROFILE_ROLE_ENV_KEY]: "pool" } });
    writeJson(join(home, ".claude-dual", "settings.json"), { env: { [PROFILE_ROLE_ENV_KEY]: "forbidden" } });

    const attrs = readProfileAttributes("claude", "dual", { home, now: NOW });
    expect(attrs.role).toBe("forbidden");
    expect(attrs.roleConflict).toBe(true);
    expect(attrs.conflictingRoles).toEqual(["pool", "forbidden"]);
    expect(attrs.sources).toHaveLength(2);
    expect(attrs.warnings.join(" ")).toContain("conflicting roles");
  });

  it("forbidden wins regardless of which observation came first", () => {
    const forbidden = { source: "b", role: "forbidden" as const, dedicatedProject: null, observedAt: NOW };
    const pool = { source: "a", role: "pool" as const, dedicatedProject: null, observedAt: NOW };
    expect(mergeProfileObservations([forbidden, pool]).role).toBe("forbidden");
    expect(mergeProfileObservations([pool, forbidden]).role).toBe("forbidden");
  });

  it("a pool/reserve disagreement takes the more restrictive reading and still reports a conflict", () => {
    const merged = mergeProfileObservations([
      { source: "a", role: "pool", dedicatedProject: null, observedAt: NOW },
      { source: "b", role: "reserve", dedicatedProject: null, observedAt: NOW },
    ]);
    expect(merged.role).toBe("reserve");
    expect(merged.roleConflict).toBe(true);
  });

  it("agreeing observations are not a conflict", () => {
    const merged = mergeProfileObservations([
      { source: "a", role: "reserve", dedicatedProject: null, observedAt: "2026-09-01T00:00:00.000Z" },
      { source: "b", role: "reserve", dedicatedProject: "kunde-x", observedAt: NOW },
    ]);
    expect(merged.roleConflict).toBe(false);
    expect(merged.conflictingRoles).toEqual([]);
    expect(merged.dedicatedProject).toBe("kunde-x");
    expect(merged.observedAt).toBe(NOW); // the newest contributing observation
  });

  it("a remote attestation merges under the same rule as a local file", () => {
    writeJson(join(home, ".claude", "settings_remote.json"), { env: { [PROFILE_ROLE_ENV_KEY]: "pool" } });
    const attrs = readProfileAttributes("claude", "remote", {
      home,
      now: NOW,
      extraObservations: [
        { source: "worker:build-2", role: "forbidden", dedicatedProject: null, observedAt: NOW },
      ],
    });
    expect(attrs.role).toBe("forbidden");
    expect(attrs.roleConflict).toBe(true);
    expect(attrs.sources).toContain("worker:build-2");
  });

  it("conflicting dedications keep the first and report the rest", () => {
    const merged = mergeProfileObservations([
      { source: "a", role: "pool", dedicatedProject: "one", observedAt: NOW },
      { source: "b", role: "pool", dedicatedProject: "two", observedAt: NOW },
    ]);
    expect(merged.dedicatedProject).toBe("one");
    expect(merged.warnings.join(" ")).toContain(PROFILE_DEDICATED_ENV_KEY);
  });

  it("no observations at all is the default reading", () => {
    expect(mergeProfileObservations([null, undefined])).toEqual(defaultProfileAttributes());
  });
});

describe("isProfileRole", () => {
  it("accepts exactly the three roles", () => {
    expect(isProfileRole("pool")).toBe(true);
    expect(isProfileRole("reserve")).toBe(true);
    expect(isProfileRole("forbidden")).toBe(true);
    expect(isProfileRole("Pool")).toBe(false);
    expect(isProfileRole(undefined)).toBe(false);
  });
});
