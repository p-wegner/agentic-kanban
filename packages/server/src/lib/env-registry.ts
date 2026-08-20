/**
 * The board's environment variables, as DATA (#615).
 *
 * Two problems this fixes. First, there was no list: 34 `KANBAN_*` vars plus a dozen
 * board-owned bare names, discoverable only by grepping for `process.env`, and eight of the
 * `KANBAN_*` ones documented nowhere at all. Second, the naming rule ("every board env var
 * is `KANBAN_*`") existed only as a convention, so vars kept arriving with names that read
 * like someone else's — `AGENT_COMMAND`, `MOCK_AGENT`, `SLOW_REQUEST_THRESHOLD_MS`. In an
 * agent's spawn env, sitting beside the agent CLI's own variables, an unprefixed name is
 * genuinely ambiguous about who owns it.
 *
 * A registry rather than a doc because a doc drifts: `docs/env-vars.md` is checked AGAINST
 * this array by `env-registry-doc-parity.test.ts`, so a new variable cannot be added
 * without documenting it, and a documented one cannot quietly disappear.
 *
 * Renaming is additive and reversible: `readBoardEnv` prefers the `KANBAN_*` name and still
 * honours the legacy one, warning ONCE. Nobody's script breaks on upgrade — which is the
 * only reason a rename of `DB_URL` is safe to attempt at all.
 */

export type EnvScope =
  | "board"        // read by the board server / CLI
  | "agent-spawn"  // placed into an agent subprocess's environment
  | "test"         // only meaningful under vitest
  | "scaffold";    // read by the hook/guard scripts shipped into other repos

export interface BoardEnvVar {
  /** The canonical, `KANBAN_`-prefixed name. */
  name: string;
  /**
   * A pre-#615 unprefixed name that is still honoured. Reading through it logs a one-time
   * deprecation line naming the replacement.
   */
  legacyAlias?: string;
  scope: EnvScope;
  purpose: string;
}

/**
 * The seven bare names #615 called out, now aliased. Deliberately NOT an exhaustive
 * migration of every unprefixed variable: `AGENTIC_KANBAN_*` (8 vars) is already an
 * unambiguous board prefix and reads fine, and the `scaffold/` guards' variables
 * (`ALLOW_CROSS_WORKTREE_WRITE`, `ALLOW_VITAL_DESTROY`, `VITAL_FILES`, `VERIFY_GATE_*`)
 * ship INTO other people's repos, where renaming is a separate decision with its own
 * upgrade story. Both are listed in docs/env-vars.md under "not renamed, and why".
 */
export const KANBAN_ENV: readonly BoardEnvVar[] = [
  {
    name: "KANBAN_DB_URL",
    legacyAlias: "DB_URL",
    scope: "board",
    purpose: "Explicit libsql connection URL; wins over every other DB-location rule.",
  },
  {
    name: "KANBAN_ALLOW_DB_DESTROY",
    legacyAlias: "ALLOW_DB_DESTROY",
    scope: "board",
    purpose: "Set to 1 to let `db-repair` perform a destructive repair without --force.",
  },
  {
    name: "KANBAN_AGENT_COMMAND",
    legacyAlias: "AGENT_COMMAND",
    scope: "board",
    purpose: "Override the agent binary the board spawns. Presence also implies a mock agent.",
  },
  {
    name: "KANBAN_MOCK_AGENT",
    legacyAlias: "MOCK_AGENT",
    scope: "board",
    purpose: "Set to 1 to force the mock agent regardless of the configured profile.",
  },
  {
    name: "KANBAN_STUCK_BUILDER_TIMEOUT_MS",
    legacyAlias: "STUCK_BUILDER_TIMEOUT_MS",
    scope: "board",
    purpose: "How long a builder may be silent before the monitor treats it as stuck.",
  },
  {
    name: "KANBAN_PLUGIN_VIEW_READY_TIMEOUT_MS",
    legacyAlias: "PLUGIN_VIEW_READY_TIMEOUT_MS",
    scope: "board",
    purpose: "How long to wait for a plugin view's child server to become reachable.",
  },
  {
    name: "KANBAN_SLOW_REQUEST_THRESHOLD_MS",
    legacyAlias: "SLOW_REQUEST_THRESHOLD_MS",
    scope: "board",
    purpose: "Request duration above which the slow-request middleware logs a warning.",
  },
];

const byName = new Map(KANBAN_ENV.map((v) => [v.name, v]));

/** One warning per legacy name per process — a per-read warning would flood a request log. */
const warnedLegacy = new Set<string>();

/** Reset between tests; the warn-once state is module-global by design. */
export function __resetEnvDeprecationWarningsForTests(): void {
  warnedLegacy.clear();
}

/**
 * Read a registered board variable: canonical name first, legacy alias second.
 *
 * Returns `undefined` for unset AND for empty-string, because every caller treats an empty
 * value as absent and the alternative is each of them re-deriving that.
 */
export function readBoardEnv(
  name: string,
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = (m) => console.warn(m),
): string | undefined {
  const entry = byName.get(name);
  if (!entry) throw new Error(`readBoardEnv: ${name} is not in KANBAN_ENV — register it first`);

  const preferred = env[entry.name];
  if (preferred) return preferred;

  if (entry.legacyAlias) {
    const legacy = env[entry.legacyAlias];
    if (legacy) {
      if (!warnedLegacy.has(entry.legacyAlias)) {
        warnedLegacy.add(entry.legacyAlias);
        warn(`[env] ${entry.legacyAlias} is deprecated — rename it to ${entry.name}. Still honoured for now.`);
      }
      return legacy;
    }
  }
  return undefined;
}
