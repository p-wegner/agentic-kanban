import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * #1024 — the ONE reader for profile attributes (proposal
 * `docs/proposals/2026-09-03-dev-board-vs-deployed-board.md` §6 "Wo die Rolle wohnt").
 *
 * A profile's ROLE is a property of the ACCOUNT, not of the board: this subscription
 * belongs to customer X, that one trains on data, this one is the private emergency
 * reserve. That is true on every machine the login exists on, so it lives ON THE
 * PROFILE — in the `env` block of the settings file the profile already owns — and
 * the board only OBSERVES and caches it. Writing is claude-pick's job; nothing in
 * this repo writes these keys.
 *
 * Carriers (three, one function):
 *  1. Claude API-key profile   — `~/.claude/settings_<name>.json`      → `.env`
 *  2. Claude directory profile — `~/.claude-<name>/settings.json`      → `.env`
 *  3. Codex profile TOML       — `~/.codex/<name>.config.toml` (or the legacy
 *     `config_<name>.toml`, or `~/.codex-<name>/config.toml`) → a small `[kanban]` table
 *
 * The env keys are namespaced and deliberately TAG-shaped, never credential-shaped:
 * Claude Code injects the `env` block into every session's process environment, so a
 * hook inside a running agent can read `KANBAN_PROFILE_ROLE` and abort — a second
 * enforcement point — but everything there is visible to every child process.
 *
 * NODE-ONLY: this module reads the filesystem, so it is never client-reachable.
 *
 * WHERE IT LIVES: `packages/server/src/lib/`, not `packages/shared/src/lib/`, even though
 * the proposal's prose says "eine Funktion in `packages/shared`". The three audiences it
 * was designed for are the board's profile discovery, the worker's `hello` attestation
 * (#1027) and claude-pick - and none of them makes it a second CONSUMING PACKAGE in this
 * repo: the fleet worker is `packages/server/src/worker/`, i.e. server, and claude-pick is
 * a separate repository that cannot import `@agentic-kanban/shared/lib/*` at all. So the
 * consumer count here is 1 forever, which is exactly the case
 * `shared-lib-single-consumer-ratchet.test.ts` (#590/#730) exists to keep out of
 * `shared/lib`, and grandfathering it on a promised second consumer would have been a
 * false promise. Server code imports it relatively (`../lib/profile-attributes.js`).
 */

/**
 * The role vocabulary itself lives in the PURE `profile-roster.ts` (#1025) — the roster
 * resolver is client-reachable and this reader is node-only, so a second declaration here
 * would be the one place the two halves could disagree about what a role is. Re-exported
 * so every existing importer of this module keeps working unchanged.
 */
export { DEFAULT_PROFILE_ROLE, PROFILE_ROLES, isProfileRole } from "@agentic-kanban/shared/lib/profile-roster";
export type { ProfileRole } from "@agentic-kanban/shared/lib/profile-roster";
import { DEFAULT_PROFILE_ROLE, PROFILE_ROLES, isProfileRole, type ProfileRole } from "@agentic-kanban/shared/lib/profile-roster";

export const PROFILE_ROLE_ENV_KEY = "KANBAN_PROFILE_ROLE";
export const PROFILE_DEDICATED_ENV_KEY = "KANBAN_PROFILE_DEDICATED";

/** The `[kanban]` TOML table and its keys (the Codex carrier). */
export const PROFILE_TOML_TABLE = "kanban";
const TOML_ROLE_KEYS = ["role", PROFILE_ROLE_ENV_KEY];
const TOML_DEDICATED_KEYS = ["dedicated", PROFILE_DEDICATED_ENV_KEY];

/** One carrier's reading of one profile. Several may exist for a single profile NAME. */
export interface ProfileAttributeObservation {
  /** Where this came from — a file path, or a worker/machine label for a remote attestation. */
  source: string;
  role: ProfileRole;
  /** `KANBAN_PROFILE_DEDICATED` — "forbidden everywhere except this project slug". */
  dedicatedProject: string | null;
  /** ISO timestamp of the observation (the `loggedIn`-style cache stamp). */
  observedAt: string;
  /** A role value that was present but not one of `PROFILE_ROLES` (fell back to `pool`). */
  unknownRole?: string;
}

/** The merged view stored on a profile record and rendered into its DTO. */
export interface ProfileAttributes {
  role: ProfileRole;
  dedicatedProject: string | null;
  /** ISO of the newest contributing observation; null when nothing declared anything. */
  observedAt: string | null;
  /** Two observations of the same profile name disagreed about the role. */
  roleConflict: boolean;
  /** The distinct roles seen, in `PROFILE_ROLES` order — only meaningful on a conflict. */
  conflictingRoles: ProfileRole[];
  /** Every carrier that contributed, in read order. */
  sources: string[];
  /** Unknown values, conflicts — surfaced rather than logged and lost. */
  warnings: string[];
}

/** The board never writes these keys; this is the empty/default reading. */
export function defaultProfileAttributes(): ProfileAttributes {
  return {
    role: DEFAULT_PROFILE_ROLE,
    dedicatedProject: null,
    observedAt: null,
    roleConflict: false,
    conflictingRoles: [],
    sources: [],
    warnings: [],
  };
}

function trimmedOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Read one observation out of a settings `env` block (carriers 1 and 2 — both Claude
 * profile shapes hand the same object here). Returns null when NEITHER key is present:
 * a file that says nothing is not an observation, it is silence, and silence must not
 * outrank a real `forbidden` read elsewhere.
 *
 * An unknown role value degrades to `pool` WITH a warning rather than throwing — a
 * typo in a settings file must not take the board's profile list down.
 */
export function readProfileAttributesFromEnv(
  env: unknown,
  source: string,
  now?: string,
): ProfileAttributeObservation | null {
  if (!env || typeof env !== "object" || Array.isArray(env)) return null;
  const rec = env as Record<string, unknown>;
  const rawRole = trimmedOrNull(rec[PROFILE_ROLE_ENV_KEY]);
  const dedicatedProject = trimmedOrNull(rec[PROFILE_DEDICATED_ENV_KEY]);
  if (rawRole === null && dedicatedProject === null) return null;

  const observedAt = now ?? new Date().toISOString();
  if (rawRole !== null && !isProfileRole(rawRole)) {
    return { source, role: DEFAULT_PROFILE_ROLE, dedicatedProject, observedAt, unknownRole: rawRole };
  }
  return { source, role: rawRole ?? DEFAULT_PROFILE_ROLE, dedicatedProject, observedAt };
}

/**
 * Minimal `[kanban]`-table reader for a Codex profile TOML (carrier 3).
 *
 * Deliberately NOT a TOML parser: we need two string keys out of one named table, and
 * pulling a parser dependency into `shared` for that is cost with no payoff. Reads only
 * `key = "value"` (single or double quoted, or bare) lines inside `[kanban]`, stopping at
 * the next table header. Anything it cannot make sense of is silence, same as a missing file.
 */
export function readProfileAttributesFromToml(
  toml: string,
  source: string,
  now?: string,
): ProfileAttributeObservation | null {
  let inTable = false;
  const values = new Map<string, string>();
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      // `[kanban]` only — an array-of-tables `[[kanban]]` is not the declared carrier.
      inTable = /^\[\s*([A-Za-z0-9_-]+)\s*\]$/.exec(line)?.[1] === PROFILE_TOML_TABLE;
      continue;
    }
    if (!inTable) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const hash = value.indexOf(" #");
    if (!value.startsWith('"') && !value.startsWith("'") && hash >= 0) value = value.slice(0, hash).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    if (key && !values.has(key)) values.set(key, value);
  }
  if (values.size === 0) return null;

  const pick = (keys: string[]): string | null => {
    for (const k of keys) {
      const v = trimmedOrNull(values.get(k));
      if (v !== null) return v;
    }
    return null;
  };
  // Reuse the env reader so the two carriers cannot disagree about parsing rules.
  const env: Record<string, string> = {};
  const role = pick(TOML_ROLE_KEYS);
  const dedicated = pick(TOML_DEDICATED_KEYS);
  if (role !== null) env[PROFILE_ROLE_ENV_KEY] = role;
  if (dedicated !== null) env[PROFILE_DEDICATED_ENV_KEY] = dedicated;
  return readProfileAttributesFromEnv(env, source, now);
}

/** Read a settings JSON file's `env` block. Unreadable/invalid JSON → silence. */
export function readProfileAttributesFromSettingsFile(
  path: string,
  now?: string,
): ProfileAttributeObservation | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return readProfileAttributesFromEnv((parsed as Record<string, unknown>).env, path, now);
  } catch {
    return null;
  }
}

/** Read a Codex profile TOML's `[kanban]` table. Unreadable → silence. */
export function readProfileAttributesFromTomlFile(
  path: string,
  now?: string,
): ProfileAttributeObservation | null {
  try {
    if (!existsSync(path)) return null;
    return readProfileAttributesFromToml(readFileSync(path, "utf8"), path, now);
  } catch {
    return null;
  }
}

/**
 * Merge every observation of ONE profile name.
 *
 * The conflict rule (proposal §6): two machines — or two carriers on this one — that
 * disagree about the same account resolve to **`forbidden` wins**, and the disagreement
 * is EXPOSED rather than silently resolved, because the safe reading of "somebody
 * somewhere marked this account as never-touch" is to honour it and show why.
 * A `reserve`/`pool` disagreement resolves to `reserve` on the same principle
 * (the more restrictive reading), and is still reported as a conflict.
 */
export function mergeProfileObservations(
  observations: Array<ProfileAttributeObservation | null | undefined>,
): ProfileAttributes {
  const seen = observations.filter((o): o is ProfileAttributeObservation => !!o);
  const result = defaultProfileAttributes();
  if (seen.length === 0) return result;

  result.sources = seen.map((o) => o.source);
  const roles = new Set<ProfileRole>(seen.map((o) => o.role));
  const ordered = PROFILE_ROLES.filter((r) => roles.has(r));

  // Most restrictive wins: forbidden > reserve > pool.
  result.role = roles.has("forbidden") ? "forbidden" : roles.has("reserve") ? "reserve" : "pool";
  result.roleConflict = ordered.length > 1;
  result.conflictingRoles = result.roleConflict ? ordered : [];

  const dedicated = seen.map((o) => o.dedicatedProject).filter((d): d is string => !!d);
  result.dedicatedProject = dedicated[0] ?? null;

  const stamps = seen.map((o) => o.observedAt).filter(Boolean).sort();
  result.observedAt = stamps[stamps.length - 1] ?? null;

  for (const o of seen) {
    if (o.unknownRole !== undefined) {
      result.warnings.push(
        `${o.source}: unknown ${PROFILE_ROLE_ENV_KEY} "${o.unknownRole}" — treated as ${DEFAULT_PROFILE_ROLE}`,
      );
    }
  }
  if (result.roleConflict) {
    result.warnings.push(
      `conflicting roles ${ordered.join(" vs ")} across ${result.sources.join(", ")} — resolved to ${result.role}`,
    );
  }
  const distinctDedicated = [...new Set(dedicated)];
  if (distinctDedicated.length > 1) {
    result.warnings.push(
      `conflicting ${PROFILE_DEDICATED_ENV_KEY} ${distinctDedicated.join(" vs ")} — using ${result.dedicatedProject}`,
    );
  }
  return result;
}

/** The files a profile name can carry attributes in, per provider. */
export function profileAttributeCarrierPaths(
  provider: "claude" | "codex",
  profile: string,
  home: string = homedir(),
): string[] {
  const name = profile.trim();
  if (!name) return [];
  if (provider === "claude") {
    return [
      join(home, ".claude", `settings_${name}.json`),
      join(home, `.claude-${name}`, "settings.json"),
    ];
  }
  return [
    join(home, ".codex", `${name}.config.toml`),
    join(home, ".codex", `config_${name}.toml`),
    join(home, `.codex-${name}`, "config.toml"),
  ];
}

export interface ReadProfileAttributesOptions {
  /** Override the home dir — the seam the tests (and a worker with its own HOME) use. */
  home?: string;
  /** Extra carriers: a ring entry's custom config dir, a worker's `hello` attestation file. */
  extraPaths?: string[];
  /** Observations attested elsewhere (another machine); merged under the same conflict rule. */
  extraObservations?: Array<ProfileAttributeObservation | null | undefined>;
  /** ISO stamp for the observation (persisted on the profile record). */
  now?: string;
}

/**
 * THE reader: every carrier for one profile name, merged. Missing everywhere → `pool`.
 * Used by board profile discovery, the worker `hello`, and claude-pick.
 */
export function readProfileAttributes(
  provider: "claude" | "codex",
  profile: string,
  options: ReadProfileAttributesOptions = {},
): ProfileAttributes {
  const { home, extraPaths = [], extraObservations = [], now } = options;
  const paths = [...profileAttributeCarrierPaths(provider, profile, home), ...extraPaths];
  const observations = paths.map((p) =>
    p.toLowerCase().endsWith(".toml")
      ? readProfileAttributesFromTomlFile(p, now)
      : readProfileAttributesFromSettingsFile(p, now),
  );
  return mergeProfileObservations([...observations, ...extraObservations]);
}
