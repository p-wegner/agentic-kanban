/**
 * Which agent profiles does THIS machine hold, and how is one selected at launch (#1027)?
 *
 * The board has known this about its own machine forever, spread across
 * `claude-subscription-ring.ts`, `codex-license-ring.ts` and the provider helpers — all
 * of which sit behind the board's service graph (db, drizzle, hono) that a fleet worker
 * deliberately never loads (`worker-cli-isolation.test.ts`). A worker needs the same two
 * answers and none of that weight:
 *
 *  1. **Attestation** — which profile NAMES can I authenticate as? (`hello`/heartbeat)
 *  2. **Resolution** — the board's assign names profile `anth`; what does running as
 *     `anth` mean on this machine — and do I even know that name?
 *
 * So the shapes live here, in a node-only shared module with no dependencies, and the
 * rules are the ones the board's own launcher applies:
 *
 * | carrier | selected by |
 * |---|---|
 * | `~/.claude/settings_<name>.json` (API-key profile) | `--settings <path>` |
 * | `~/.claude-<name>/` with a login (OAuth subscription) | `CLAUDE_CONFIG_DIR=<dir>` |
 * | `~/.codex-<name>/` with `config.toml`/`auth.json` (OAuth license) | `CODEX_HOME=<dir>` |
 * | `~/.codex/<name>.config.toml`, `~/.codex/config_<name>.toml` (API-key license) | `--profile <name>` |
 *
 * NOTHING here reads a credential's CONTENT. Existence is the whole question: a worker
 * attests names, and the token stays where it is (decision 012). Reading `.credentials.json`
 * for quota is a separate, deliberate act (`oauth-quota-core.ts`) and its output is a
 * percentage, never the token.
 *
 * NODE-ONLY: imports `node:fs`/`node:os`/`node:path`. Import it via the deep path
 * `../lib/local-profile-discovery.js`; it must NEVER be re-exported from
 * the client-reachable barrel (`lib/index.ts`) — see `barrel-client-safety.test.ts`.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The two providers whose profiles are a machine-local login. */
export type LocalProfileProvider = "claude" | "codex";

/** How this profile is selected at launch — the difference decides env vs argv. */
export type LocalProfileKind = "claude-settings" | "claude-config-dir" | "codex-home" | "codex-toml";

export interface LocalProfile {
  provider: LocalProfileProvider;
  name: string;
  kind: LocalProfileKind;
  /** The carrier that proved it exists — a settings file, a toml, or a config directory. */
  path: string;
}

/** What running under this profile means, as env and/or extra argv. */
export interface LocalProfileLaunchAdjustment {
  env: Record<string, string>;
  args: string[];
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** A `~/.claude-<name>` directory only counts when it actually holds a login. */
function claudeDirHasLogin(dir: string): boolean {
  return existsSync(join(dir, ".credentials.json")) || existsSync(join(dir, "settings.json"));
}

/** Mirrors `codex-license-ring.ts`'s `discoverAuthFiles` — a home is one of these two files. */
function codexDirHasLogin(dir: string): boolean {
  return existsSync(join(dir, "config.toml")) || existsSync(join(dir, "auth.json"));
}

/**
 * Every profile this machine holds, deduped by `provider:name` in carrier-precedence
 * order (settings file before config dir, the same order `buildSpawnEnv` resolves them).
 *
 * The default `~/.claude` / `~/.codex` login is deliberately NOT listed: it has no name to
 * attest, and "whatever this machine is logged into by default" is exactly the answer a
 * profile restriction exists to refuse.
 */
export function discoverLocalProfiles(home: string = homedir()): LocalProfile[] {
  const out: LocalProfile[] = [];
  const seen = new Set<string>();
  const add = (profile: LocalProfile): void => {
    const id = `${profile.provider}:${profile.name}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(profile);
  };

  const claudeDir = join(home, ".claude");
  for (const entry of listEntries(claudeDir)) {
    const match = /^settings_(.+)\.json$/.exec(entry);
    if (match?.[1]) add({ provider: "claude", name: match[1], kind: "claude-settings", path: join(claudeDir, entry) });
  }
  const codexDir = join(home, ".codex");
  for (const entry of listEntries(codexDir)) {
    const named = /^(.+)\.config\.toml$/.exec(entry) ?? /^config_(.+)\.toml$/.exec(entry);
    if (named?.[1]) add({ provider: "codex", name: named[1], kind: "codex-toml", path: join(codexDir, entry) });
  }
  // Sibling config DIRECTORIES: `~/.claude-<name>` and `~/.codex-<name>`.
  for (const entry of listEntries(home)) {
    const claude = /^\.claude-(.+)$/.exec(entry);
    if (claude?.[1]) {
      const dir = join(home, entry);
      if (isDir(dir) && claudeDirHasLogin(dir)) {
        add({ provider: "claude", name: claude[1], kind: "claude-config-dir", path: dir });
      }
      continue;
    }
    const codex = /^\.codex-(.+)$/.exec(entry);
    if (codex?.[1]) {
      const dir = join(home, entry);
      if (isDir(dir) && codexDirHasLogin(dir)) {
        add({ provider: "codex", name: codex[1], kind: "codex-home", path: dir });
      }
    }
  }
  return out;
}

/**
 * Resolve ONE profile name on this machine. Null means "I do not know that name" — which
 * a worker turns into a REJECTED assign rather than a launch on some other account.
 */
export function findLocalProfile(
  provider: string,
  name: string,
  home: string = homedir(),
): LocalProfile | null {
  const wanted = name.trim();
  if (!wanted) return null;
  const wantedProvider = provider.trim().toLowerCase();
  return (
    discoverLocalProfiles(home).find(
      (p) => p.name === wanted && (wantedProvider === "" || p.provider === wantedProvider),
    ) ?? null
  );
}

/**
 * What to add to a launch so it runs AS this profile.
 *
 * The env/argv split is not stylistic: an OAuth login is selected by pointing the CLI at
 * a whole config directory (there is no flag for it), while an API-key profile is a file
 * the CLI takes as an argument. Getting it backwards authenticates as the machine's
 * default account while reporting the requested one — the exact failure #1027's rejection
 * path exists to make impossible.
 */
export function localProfileLaunchAdjustment(profile: LocalProfile): LocalProfileLaunchAdjustment {
  switch (profile.kind) {
    case "claude-settings":
      return { env: {}, args: ["--settings", profile.path] };
    case "claude-config-dir":
      return { env: { CLAUDE_CONFIG_DIR: profile.path }, args: [] };
    case "codex-home":
      return { env: { CODEX_HOME: profile.path }, args: [] };
    case "codex-toml":
      return { env: {}, args: ["--profile", profile.name] };
  }
}
