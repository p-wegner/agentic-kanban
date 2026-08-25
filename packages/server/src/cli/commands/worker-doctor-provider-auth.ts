import { join } from "node:path";

/**
 * Where a provider's login actually lives on THIS machine (#875).
 *
 * `checkProvider` used to resolve every provider's auth files as `join(homedir(), dir)`,
 * ignoring the env vars that RELOCATE the whole login wholesale — which is exactly how a
 * fleet worker is configured: the Windows service pins `CLAUDE_CONFIG_DIR` per install
 * (`-ClaudeConfigDir`, ak-worker-service.ps1), and the auth-rotation rings swap logins by
 * pointing `CLAUDE_CONFIG_DIR` / `CODEX_HOME` at per-subscription directories
 * (claude-subscription-ring.ts / codex-license-ring.ts). So the doctor inspected
 * `~/.claude` while the dispatched agent authenticated from somewhere else entirely — a
 * check that is wrong precisely on the machines it was built for.
 *
 * The env var REPLACES the default directory wholesale: credentials sit DIRECTLY in
 * `$CLAUDE_CONFIG_DIR` / `$CODEX_HOME` (the ring's `dirHasAuth` reads them there), so the
 * table's `dir: ".claude"` fragment stops applying — it is joined under the home dir only
 * on the default path. Each provider gets its own resolution rule; a provider without one
 * keeps the plain home-relative default.
 *
 * Every resolver takes `env` defaulting to `process.env` so tests stay hermetic
 * (vi.stubEnv, or an explicit env object — the pattern
 * worker-doctor-lazy-transport-and-trust.test.ts established for the trust check).
 * The `source` names WHAT decided, because the check output must always name the
 * consulted path AND why it was the one consulted.
 *
 * Lives in its own module rather than `worker-doctor.ts` because that file sits at the
 * god-module gate's 20-declaration ceiling (#889) — same reason as
 * worker-doctor-node-check.ts. Db-free: this ships in the standalone worker binary.
 */
export interface ProviderAuthDir {
  /** The directory the login files are looked up in. */
  dir: string;
  /** What decided it — the env var by name, or the home-relative default. */
  source: string;
}

export function resolveClaudeAuthDir(home: string, env: NodeJS.ProcessEnv = process.env): ProviderAuthDir {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) return { dir: configDir, source: "CLAUDE_CONFIG_DIR" };
  return { dir: join(home, ".claude"), source: "the default ~/.claude" };
}

export function resolveCodexAuthDir(home: string, env: NodeJS.ProcessEnv = process.env): ProviderAuthDir {
  const codexHome = env.CODEX_HOME?.trim();
  if (codexHome) return { dir: codexHome, source: "CODEX_HOME" };
  return { dir: join(home, ".codex"), source: "the default ~/.codex" };
}

/**
 * Per-provider resolution rules. A plain mutable Record on purpose, mirroring
 * `PROVIDER_AUTH_FILES`: tests inject a fake provider to exercise `checkProvider`
 * without needing that provider's real CLI on the machine.
 */
export const PROVIDER_AUTH_DIR_RESOLVERS: Record<
  string,
  (home: string, env?: NodeJS.ProcessEnv) => ProviderAuthDir
> = {
  claude: resolveClaudeAuthDir,
  codex: resolveCodexAuthDir,
};

/**
 * The auth directory for `provider`: its own env-aware rule when one exists, else the
 * home-relative `fallbackDir` from the `PROVIDER_AUTH_FILES` table.
 */
export function resolveProviderAuthDir(
  provider: string,
  fallbackDir: string,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): ProviderAuthDir {
  const resolver = PROVIDER_AUTH_DIR_RESOLVERS[provider];
  if (resolver) return resolver(home, env);
  return { dir: join(home, fallbackDir), source: `the default ~/${fallbackDir}` };
}
