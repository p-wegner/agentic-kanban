import { execFile } from "node:child_process";
import { basename, delimiter, join } from "node:path";
import { existsSync } from "node:fs";
import { splitArgs } from "./agent-provider/helpers.js";
import type { ProviderName } from "./agent-provider.js";

/**
 * CLI version detection for the agent executors (claude/codex/copilot/pi).
 *
 * The biggest external-dependency risk in this codebase: every launch flag
 * (`--output-format stream-json`, `codex --json`, `--dangerously-bypass-…`,
 * `copilot --allow-tool=`, Pi rejecting `--approve`) is an UNVERSIONED contract
 * with a third-party CLI that ships breaking changes. Binary-exists checks
 * (agent-profile-health) never asserted the binary speaks the protocol we expect.
 *
 * This service runs `<cli> --version`, parses the semver, and checks it against a
 * per-provider supported range so preflight surfaces an actionable error
 * ("Codex 1.x detected, expected >=0.x <… — flags may have changed") instead of
 * letting a renamed flag fail every launch with an opaque crash.
 */

export interface CliVersionConfig {
  /** Args that print the version (almost always `["--version"]`). */
  versionArgs: string[];
  /** Lowest version known to honor the flags this codebase hard-codes (inclusive). */
  minSupported: string;
  /**
   * NEWEST version verified against the flag contract (inclusive — the
   * last-tested-known-good release). When a detected version is STRICTLY GREATER
   * than this, the guard emits a warning, not a hard error — the CLI may still
   * work, but the contract is no longer guaranteed (auto-updating CLIs routinely
   * rename stream events / flags). Null disables the ceiling (never do this for a
   * real provider — it makes the "above-known" branch unreachable, #956).
   */
  maxKnown: string | null;
}

/**
 * Per-provider supported version ranges. These are intentionally permissive —
 * the goal is to catch a wholesale rename/major-bump (the failure mode the ticket
 * describes), not to pin a patch version.
 *
 * MAINTENANCE (#956): when a provider CLI updates, the launch-path guard and the
 * profile-health panel start warning "newer than the last verified version".
 * That warning is the prompt to re-verify the flag/stream contract against the
 * new release and BUMP `maxKnown` here. Do not silence it by setting null.
 * Last verified: 2026-07-02 (claude 2.1.198, codex 0.142.0, copilot 1.0.56,
 * pi 0.73.1 — the versions installed when #956 landed).
 */
export const CLI_VERSION_CONFIG: Record<ProviderName, CliVersionConfig> = {
  claude: { versionArgs: ["--version"], minSupported: "1.0.0", maxKnown: "2.1.198" },
  codex: { versionArgs: ["--version"], minSupported: "0.20.0", maxKnown: "0.142.0" },
  copilot: { versionArgs: ["--version"], minSupported: "0.1.0", maxKnown: "1.0.56" },
  // Canonical breaking-change symptom lives here: Pi 0.73.1 rejects `--approve`.
  // We don't add that flag, but the lower bound documents the verified-good floor.
  pi: { versionArgs: ["--version"], minSupported: "0.70.0", maxKnown: "0.73.1" },
};

export interface CliVersionResult {
  /** True if a version string was successfully obtained and parsed. */
  detected: boolean;
  /** The raw `--version` stdout (trimmed), for diagnostics. Null if the call failed. */
  raw: string | null;
  /** Parsed `major.minor.patch`, or null if unparseable / not detected. */
  version: string | null;
  /**
   * "ok" — within range; "below-min" — older than minSupported (hard error);
   * "above-known" — newer than maxKnown (warning); "unparseable" — got output but
   * no semver; "unavailable" — the CLI couldn't be run at all.
   */
  status: "ok" | "below-min" | "above-known" | "unparseable" | "unavailable";
  /** Human-readable explanation when status !== "ok". */
  message: string | null;
}

/** Injectable runner so tests don't spawn real binaries. Returns trimmed stdout or throws. */
export type VersionRunner = (command: string, args: string[]) => Promise<string>;

const DEFAULT_VERSION_TIMEOUT_MS = 5000;

const defaultRunner: VersionRunner = (command, args) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: DEFAULT_VERSION_TIMEOUT_MS, windowsHide: true, shell: process.platform === "win32" },
      (err, stdout, stderr) => {
        if (err) {
          reject(err);
          return;
        }
        // Some CLIs print the version to stderr; fall back to it.
        const out = (stdout && stdout.trim()) || (stderr && stderr.trim()) || "";
        resolve(out);
      },
    );
  });

/**
 * Resolve the launch command (which may include args, e.g. `node x.js`) to an
 * executable path on PATH. Mirrors agent-profile-health's commandExists resolution
 * so the version probe targets the SAME binary a launch would.
 */
export function resolveExecutable(command: string): string | null {
  const first = splitArgs(command)[0] ?? command.trim();
  if (!first) return null;
  const unquoted = first.replace(/^"|"$/g, "");
  if (/[\\/]/.test(unquoted)) return existsSync(unquoted) ? unquoted : null;

  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT", ".PS1"])
    : [""];
  const names = extensions.includes("")
    ? [unquoted]
    : [unquoted, ...extensions.map((ext) => `${unquoted}${ext.toLowerCase()}`), ...extensions.map((ext) => `${unquoted}${ext.toUpperCase()}`)];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/** Extract the first `major.minor.patch` (optionally with a prerelease tag) from arbitrary text. */
export function parseSemver(text: string): string | null {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/** Compare two `major.minor.patch` strings. Returns <0, 0, or >0. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Detect and validate the version of a provider's CLI.
 *
 * `command` is the resolved launch command from settings (may be a bare name like
 * "codex" or a full path). Returns a structured result; never throws.
 */
export async function detectCliVersion(
  provider: ProviderName,
  command: string,
  runner: VersionRunner = defaultRunner,
): Promise<CliVersionResult> {
  const config = CLI_VERSION_CONFIG[provider];
  const executable = resolveExecutable(command);
  if (!executable) {
    return {
      detected: false,
      raw: null,
      version: null,
      status: "unavailable",
      message: `Could not resolve ${provider} CLI on PATH to probe its version.`,
    };
  }

  let raw: string;
  try {
    raw = (await runner(executable, config.versionArgs)).trim();
  } catch (err) {
    return {
      detected: false,
      raw: null,
      version: null,
      status: "unavailable",
      message: `Could not run '${basename(executable)} ${config.versionArgs.join(" ")}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const version = parseSemver(raw);
  if (!version) {
    return {
      detected: false,
      raw,
      version: null,
      status: "unparseable",
      message: `Could not parse a version number from ${provider} --version output: "${raw.slice(0, 120)}".`,
    };
  }

  if (compareSemver(version, config.minSupported) < 0) {
    return {
      detected: true,
      raw,
      version,
      status: "below-min",
      message: `${provider} CLI version ${version} is below the supported minimum ${config.minSupported}. The hard-coded launch flags may not work; upgrade the CLI.`,
    };
  }

  if (config.maxKnown && compareSemver(version, config.maxKnown) > 0) {
    return {
      detected: true,
      raw,
      version,
      status: "above-known",
      message: `${provider} CLI version ${version} is newer than the last verified version ${config.maxKnown}. Launch flags/stream format may have changed; verify a launch end-to-end, then bump maxKnown in agent-cli-version.service.ts.`,
    };
  }

  return { detected: true, raw, version, status: "ok", message: null };
}

// ---------------------------------------------------------------------------
// Launch-path guard (#956)
//
// Profile-health preflight was the ONLY consumer of detectCliVersion, so a CLI
// that auto-updated between preflights sailed through every launch unchecked.
// The launch path now consults the guard via a TTL cache so we do NOT add a
// `--version` subprocess to every spawn — one probe per provider:command per TTL.
// ---------------------------------------------------------------------------

const VERSION_CACHE_TTL_MS = 30 * 60_000;

interface VersionCacheEntry {
  result: CliVersionResult;
  at: number;
}

const versionCache = new Map<string, VersionCacheEntry>();

/** Clear the probe cache (tests). */
export function resetCliVersionCache(): void {
  versionCache.clear();
}

/**
 * detectCliVersion behind a TTL cache keyed by `provider:command`. Safe to call
 * on every launch — a real `--version` subprocess is spawned at most once per
 * key per TTL window.
 */
export async function detectCliVersionCached(
  provider: ProviderName,
  command: string,
  opts?: { runner?: VersionRunner; nowFn?: () => number; ttlMs?: number },
): Promise<CliVersionResult> {
  const key = `${provider}:${command}`;
  const now = (opts?.nowFn ?? Date.now)();
  const ttl = opts?.ttlMs ?? VERSION_CACHE_TTL_MS;
  const hit = versionCache.get(key);
  if (hit && now - hit.at < ttl) return hit.result;
  const result = await detectCliVersion(provider, command, opts?.runner);
  versionCache.set(key, { result, at: now });
  return result;
}

/**
 * The launch-path check: probe (cached) and WARN — never block the launch — when
 * the installed CLI is below the supported floor or newer than the last verified
 * version. `unparseable`/`unavailable` stay silent here: test substitutes
 * (AGENT_COMMAND, node scripts) legitimately have no semver, and "not installed"
 * is owned by profile-health preflight. Never throws.
 *
 * No board_health_events emission: that helper (board-health-events.repository)
 * requires a projectId + monitor cycleId that the spawn site does not have —
 * console.warn is the proportionate signal here; profile-health surfaces the
 * same verdict in the UI.
 */
export async function warnIfCliVersionRisky(
  provider: ProviderName,
  command: string,
  opts?: { runner?: VersionRunner; nowFn?: () => number; ttlMs?: number; warn?: (message: string) => void },
): Promise<CliVersionResult | null> {
  const warn = opts?.warn ?? ((message: string) => console.warn(message));
  try {
    const result = await detectCliVersionCached(provider, command, opts);
    if ((result.status === "below-min" || result.status === "above-known") && result.message) {
      warn(`[agent-cli-version] ${result.message}`);
    }
    return result;
  } catch (err) {
    // Defensive: the guard must never escalate into a launch failure.
    console.warn(`[agent-cli-version] probe failed for ${provider}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
