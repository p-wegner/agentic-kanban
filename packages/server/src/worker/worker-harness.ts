/**
 * The worker's own provider harness config (#1367).
 *
 * A remote session used to inherit the owner's whole `~/.claude` / `~/.codex` and env: user
 * hooks, plugins, dozens of skills, the global CLAUDE.md. Results then depended on the machine.
 * The worker now owns a config dir per provider under its state dir and launches every session
 * with `CLAUDE_CONFIG_DIR` / `CODEX_HOME` pointing there, so a session is the same on every
 * machine. Credentials are created ON the worker (`agentic-kanban-worker auth ...`) and never
 * leave it - the board stores and relays nothing (decision 012).
 *
 * Three modes:
 *  - `clean`   (default) `<state>/harness/<provider>`, a minimal settings.json, no hooks.
 *  - `custom`  `--config-dir` / `--codex-home`: an existing folder the operator chose.
 *  - `inherit` `--inherit-user-config`: today's behaviour ("dirty mode"), nothing is changed.
 *
 * Db-free: this ships in the standalone worker binary.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { WorkerLaunchSpec } from "@agentic-kanban/shared/lib/worker-protocol";

export type HarnessMode = "clean" | "custom" | "inherit";

/** The env var a provider reads its stored OAuth token from. */
export const CLAUDE_TOKEN_ENV_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

/** `claude setup-token` mints a token valid for one year. */
const SETUP_TOKEN_VALIDITY_MS = 365 * 24 * 3_600_000;

export interface WorkerHarnessOptions {
  /** The worker's state file; the harness lives in a `harness/` dir beside it. */
  stateFile: string;
  inheritUserConfig?: boolean;
  /** `--config-dir`: a custom claude config folder. */
  claudeConfigDir?: string;
  /** `--codex-home`: a custom codex home folder. */
  codexHome?: string;
}

/** Encrypts a secret at rest. Injectable so tests need no PowerShell. */
export interface SecretProtector {
  protect(secret: string): { protection: string; data: string };
  unprotect(protection: string, data: string): string | undefined;
}

export interface StoredTokenStatus {
  stored: boolean;
  /** Epoch ms; the setup-token validity window counted from when it was stored. */
  expiresAtMs?: number;
  storedAtMs?: number;
  expired?: boolean;
}

export interface WorkerHarness {
  mode: HarnessMode;
  /** `<state>/harness` */
  root: string;
  /** The dir this provider's sessions run with, or undefined (inherit / unmanaged provider). */
  dirFor(provider: string): string | undefined;
  /** `{ CLAUDE_CONFIG_DIR }` / `{ CODEX_HOME }` for the provider; `{}` when it is not relocated. */
  envFor(provider: string): Record<string, string>;
  tokenStatus(provider: string, nowMs?: number): StoredTokenStatus;
  /** The decrypted token, read at the last moment before a spawn. Never log it. */
  readToken(provider: string): string | undefined;
  storeToken(provider: string, token: string, nowMs?: number): void;
  /** Create the dir (and a minimal settings.json for claude) when this worker owns it. */
  ensure(provider: string): void;
  stateFile: string;
  /** Where a stored token lives for the provider (beside this worker's state file). */
  tokenPath(provider: string): string;
  /** ` --config-dir X --state-file Y` as needed for a command to hit THIS worker's folder ('' = defaults). */
  authFlags(provider: string): string;
  protector: SecretProtector;
}

const PROVIDER_DIR_ENV: Record<string, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };

/** A claude settings.json with nothing in it that runs code: no hooks, no plugins. */
export const MINIMAL_CLAUDE_SETTINGS = { hooks: {}, enabledPlugins: {} };

const DPAPI_PREFIX =
  "Add-Type -AssemblyName System.Security; " +
  "$in = [Console]::In.ReadToEnd().Trim(); ";

/**
 * Windows DPAPI, user scope, via PowerShell (the secret travels on stdin, never argv). Elsewhere
 * a plain 0600 file - the OS's file permissions are the boundary there.
 */
export function createDefaultProtector(platform: NodeJS.Platform = process.platform): SecretProtector {
  const run = (script: string, input: string): string | undefined => {
    const res = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { input, encoding: "utf8", windowsHide: true },
    );
    return res.status === 0 ? res.stdout.trim() : undefined;
  };
  if (platform !== "win32") {
    return {
      protect: (secret) => ({ protection: "file-0600", data: Buffer.from(secret, "utf8").toString("base64") }),
      unprotect: (protection, data) =>
        protection === "file-0600" ? Buffer.from(data, "base64").toString("utf8") : undefined,
    };
  }
  return {
    protect(secret) {
      const out = run(
        DPAPI_PREFIX +
          "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect(" +
          "[Text.Encoding]::UTF8.GetBytes($in), $null, 'CurrentUser'))",
        secret,
      );
      if (!out) throw new Error("could not protect the token with Windows DPAPI");
      return { protection: "dpapi-user", data: out };
    },
    unprotect(protection, data) {
      if (protection !== "dpapi-user") return undefined;
      return run(
        DPAPI_PREFIX +
          "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect(" +
          "[Convert]::FromBase64String($in), $null, 'CurrentUser'))",
        data,
      );
    },
  };
}

interface StoredTokenFile {
  version: 1;
  protection: string;
  data: string;
  storedAt: number;
}

export function createWorkerHarness(
  options: WorkerHarnessOptions,
  protector: SecretProtector = createDefaultProtector(),
): WorkerHarness {
  const root = join(dirname(options.stateFile), "harness");
  const custom: Record<string, string | undefined> = {
    claude: options.claudeConfigDir,
    codex: options.codexHome,
  };
  const mode: HarnessMode = options.inheritUserConfig
    ? "inherit"
    : custom.claude || custom.codex
      ? "custom"
      : "clean";
  const tokenFile = (provider: string): string => join(root, `${provider}-token.json`);

  const dirFor = (provider: string): string | undefined => {
    if (mode === "inherit" || !PROVIDER_DIR_ENV[provider]) return undefined;
    return custom[provider] ?? join(root, provider);
  };
  const readFile = (provider: string): StoredTokenFile | undefined => {
    try {
      const parsed = JSON.parse(readFileSync(tokenFile(provider), "utf8")) as StoredTokenFile;
      return parsed && typeof parsed.data === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    mode,
    root,
    protector,
    stateFile: options.stateFile,
    tokenPath: tokenFile,
    authFlags(provider) {
      const parts: string[] = [];
      if (mode === "custom" && custom[provider]) parts.push(`--config-dir ${quoteIfNeeded(custom[provider]!)}`);
      if (resolve(options.stateFile) !== resolve(join(homedir(), ".agentic-kanban", "worker-state.json"))) {
        parts.push(`--state-file ${quoteIfNeeded(options.stateFile)}`);
      }
      return parts.length > 0 ? ` ${parts.join(" ")}` : "";
    },
    dirFor,
    envFor(provider) {
      const dir = dirFor(provider);
      return dir ? { [PROVIDER_DIR_ENV[provider]]: dir } : {};
    },
    tokenStatus(provider, nowMs = Date.now()) {
      const file = readFile(provider);
      if (!file) return { stored: false };
      const expiresAtMs = file.storedAt + SETUP_TOKEN_VALIDITY_MS;
      return { stored: true, storedAtMs: file.storedAt, expiresAtMs, expired: nowMs >= expiresAtMs };
    },
    readToken(provider) {
      const file = readFile(provider);
      return file ? protector.unprotect(file.protection, file.data) : undefined;
    },
    storeToken(provider, token, nowMs = Date.now()) {
      const sealed = protector.protect(token.trim());
      const body: StoredTokenFile = { version: 1, ...sealed, storedAt: nowMs };
      mkdirSync(root, { recursive: true });
      writeFileSync(tokenFile(provider), JSON.stringify(body, null, 2), { mode: 0o600 });
      try {
        chmodSync(tokenFile(provider), 0o600);
      } catch {
        /* Windows: the DPAPI seal is the protection */
      }
    },
    ensure(provider) {
      // Only the worker's OWN dir is written to; a custom folder is the operator's.
      if (mode !== "clean" || !PROVIDER_DIR_ENV[provider]) return;
      const dir = join(root, provider);
      mkdirSync(dir, { recursive: true });
      const settings = join(dir, "settings.json");
      if (provider === "claude" && !existsSync(settings)) {
        writeFileSync(settings, JSON.stringify(MINIMAL_CLAUDE_SETTINGS, null, 2));
      }
    },
  };
}

/**
 * Point one launch at the worker's harness. Pure over the spec (the token read and the dir
 * creation are the only effects, both via the harness).
 *
 *  - `inherit` or an unknown provider: untouched.
 *  - A spec that names a PROFILE keeps that profile's own dir/login (#1027) - the harness dir
 *    and the stored token do not apply. `--strict-mcp-config` still does.
 *  - claude gets `--strict-mcp-config`, so only the board bridge's MCP config loads and the
 *    repo's tracked `.claude/settings.json` mcpServers cannot start on a worker with no pnpm.
 *  - The stored token is injected into THAT provider's sessions only, via spec.env.
 */
export function applyHarnessToSpec(spec: WorkerLaunchSpec, harness: WorkerHarness | undefined): WorkerLaunchSpec {
  if (!harness || harness.mode === "inherit") return spec;
  // The board's launch intent carries the legacy executor id "claude-code" for claude.
  const provider = spec.intent?.provider === "claude-code" ? "claude" : spec.intent?.provider;
  if (!provider) return spec;
  const profiled = Boolean(spec.intent?.profile?.trim());
  const env: Record<string, string> = { ...(spec.env ?? {}) };
  const dirVar = PROVIDER_DIR_ENV[provider];
  if (!profiled && dirVar) {
    harness.ensure(provider);
    Object.assign(env, harness.envFor(provider));
  }
  if (!profiled && provider === "claude" && !env[CLAUDE_TOKEN_ENV_VAR]) {
    const token = harness.readToken(provider);
    if (token) env[CLAUDE_TOKEN_ENV_VAR] = token;
  }
  const args =
    provider === "claude" && !spec.args.includes("--strict-mcp-config")
      ? [...spec.args, "--strict-mcp-config"]
      : spec.args;
  return { ...spec, env, args };
}

/** What `start` records in the state file (#1373) so doctor / auth read the same folders the daemon uses. */
export interface PersistedHarness {
  mode: HarnessMode;
  claudeConfigDir?: string;
  codexHome?: string;
  /** Written by the legacy-keep path: the pairing predates harness modes. */
  legacy?: boolean;
}

/** The CLI flags that pick a mode/dirs. `clean` = `--clean` (switch back to the worker's own dir). */
export interface HarnessFlags {
  inheritUserConfig?: boolean;
  clean?: boolean;
  configDir?: string;
  codexHome?: string;
}

export interface ResolvedHarnessConfig {
  options: WorkerHarnessOptions;
  mode: HarnessMode;
  persisted?: PersistedHarness;
  /** A pairing exists whose state predates harness modes, and no flag chose one: stays `inherit`. */
  legacyInherit: boolean;
  /** Flags that differ from what the state file records. */
  differences: string[];
  /** What to write to the state file (start only). */
  toPersist: PersistedHarness;
}

function readStateRaw(stateFile: string): { boards?: Record<string, unknown>; harness?: PersistedHarness } {
  try {
    if (existsSync(stateFile)) return JSON.parse(readFileSync(stateFile, "utf8")) ?? {};
  } catch {
    /* unreadable = no record */
  }
  return {};
}

export function readPersistedHarness(stateFile: string): PersistedHarness | undefined {
  const h = readStateRaw(stateFile).harness;
  return h && (h.mode === "clean" || h.mode === "custom" || h.mode === "inherit") ? h : undefined;
}

export function writePersistedHarness(stateFile: string, harness: PersistedHarness): void {
  const state = readStateRaw(stateFile);
  const next = { ...state, harness };
  if (JSON.stringify(state.harness) === JSON.stringify(harness)) return;
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ boards: {}, ...next }, null, 2));
}

function persistedOf(mode: HarnessMode, claudeConfigDir?: string, codexHome?: string): PersistedHarness {
  return {
    mode,
    ...(mode === "custom" && claudeConfigDir ? { claudeConfigDir } : {}),
    ...(mode === "custom" && codexHome ? { codexHome } : {}),
  };
}

function describeConfig(h: PersistedHarness): string {
  return h.mode === "custom"
    ? `custom (${[h.claudeConfigDir && `--config-dir ${h.claudeConfigDir}`, h.codexHome && `--codex-home ${h.codexHome}`].filter(Boolean).join(" ")})`
    : h.mode;
}

/**
 * Decide the harness mode and dirs for a command (#1373): flags > what `start` recorded in the
 * state file > (a pairing that predates modes keeps `inherit`) > clean. `differences` names every
 * flag that disagrees with the record, so a caller reports it instead of silently using one.
 */
export function resolveHarnessConfig(stateFile: string, flags: HarnessFlags = {}): ResolvedHarnessConfig {
  const state = readStateRaw(stateFile);
  const persisted = readPersistedHarness(stateFile);
  const paired = Object.keys(state.boards ?? {}).length > 0;
  const flagMode: HarnessMode | undefined = flags.inheritUserConfig
    ? "inherit"
    : flags.configDir || flags.codexHome
      ? "custom"
      : flags.clean
        ? "clean"
        : undefined;
  let mode: HarnessMode;
  let claude: string | undefined;
  let codex: string | undefined;
  let legacyInherit = false;
  if (flagMode) {
    mode = flagMode;
    // A flag for one provider keeps the other's recorded dir, so `--config-dir` alone does not drop `--codex-home`.
    claude = flags.configDir ?? (persisted?.mode === "custom" ? persisted.claudeConfigDir : undefined);
    codex = flags.codexHome ?? (persisted?.mode === "custom" ? persisted.codexHome : undefined);
  } else if (persisted) {
    mode = persisted.mode;
    claude = persisted.claudeConfigDir;
    codex = persisted.codexHome;
  } else if (paired) {
    mode = "inherit";
    legacyInherit = true;
  } else {
    mode = "clean";
  }
  const toPersist = persistedOf(mode, claude, codex);
  const differences: string[] = [];
  if (flagMode && persisted && JSON.stringify(persistedOf(persisted.mode, persisted.claudeConfigDir, persisted.codexHome)) !== JSON.stringify(toPersist)) {
    differences.push(`flags ask for ${describeConfig(toPersist)} but the state file records ${describeConfig(persisted)}`);
  }
  return {
    options: { stateFile, inheritUserConfig: mode === "inherit", claudeConfigDir: claude, codexHome: codex },
    mode,
    ...(persisted ? { persisted } : {}),
    legacyInherit,
    differences,
    toPersist: legacyInherit ? { ...toPersist, legacy: true } : toPersist,
  };
}

/**
 * `auth` / `doctor` (read side): the recorded config wins; a flag that disagrees is reported, not
 * used - the daemon reads the state file, so a different folder here would log into the wrong place.
 */
export function resolveInspectedHarness(stateFile: string, flags: HarnessFlags = {}): ResolvedHarnessConfig {
  const persisted = readPersistedHarness(stateFile);
  if (persisted) {
    const withFlags = resolveHarnessConfig(stateFile, flags);
    const recorded = resolveHarnessConfig(stateFile, {});
    return { ...recorded, differences: withFlags.differences.map((d) => `${d}; using the state file's`) };
  }
  return resolveHarnessConfig(stateFile, flags);
}

function quoteIfNeeded(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

/** Registry of state files `start` has been run with, so `auth --status` can list them (#1373 F2). */
function registryFile(home: string): string {
  return join(home, ".agentic-kanban", "worker-state-files.json");
}

export function registerStateFile(stateFile: string, home: string = homedir()): void {
  try {
    const file = registryFile(home);
    const known = listRegisteredStateFiles(home);
    if (known.includes(stateFile)) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ stateFiles: [...known, stateFile] }, null, 2));
  } catch {
    /* the registry only aids discovery */
  }
}

export function listRegisteredStateFiles(home: string = homedir()): string[] {
  try {
    const parsed = JSON.parse(readFileSync(registryFile(home), "utf8")) as { stateFiles?: unknown };
    return Array.isArray(parsed.stateFiles) ? parsed.stateFiles.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** Default home state file (when present) plus every registered one that still exists. */
export function findWorkerStateFiles(defaultStateFile: string, home: string = homedir()): string[] {
  const all = [defaultStateFile, ...listRegisteredStateFiles(home)];
  return [...new Set(all)].filter((f) => existsSync(f));
}

/** Does this state file's recorded dir for the provider equal `dir`? (case-insensitive: Windows paths) */
export function stateFileUsesDir(stateFile: string, provider: string, dir: string): boolean {
  const p = readPersistedHarness(stateFile);
  const recorded = provider === "codex" ? p?.codexHome : p?.claudeConfigDir;
  return Boolean(recorded) && resolve(recorded!).toLowerCase() === resolve(dir).toLowerCase();
}

/** Does this settings.json define hooks that would run code? Absent/unreadable = no. */
export function settingsHaveHooks(settingsFile: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(settingsFile, "utf8")) as { hooks?: Record<string, unknown> };
    return Boolean(parsed.hooks && Object.values(parsed.hooks).some((v) => !Array.isArray(v) || v.length > 0));
  } catch {
    return false;
  }
}
