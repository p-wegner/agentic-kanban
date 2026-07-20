import type { DevcontainerHandle } from "@agentic-kanban/shared/lib/devcontainer-exec";
import type { AgentLaunchConfig } from "./types.js";

/**
 * Rewrites a provider's host `AgentLaunchConfig` into one that runs the SAME
 * agent inside an already-provisioned devcontainer.
 *
 * This is deliberately a PURE function sitting between `buildLaunchConfig()` and
 * the single `spawn()` in agent.service.ts — the providers stay completely
 * unaware of containerization, and the transformation is unit-testable without
 * Docker.
 *
 * It goes through `docker exec` rather than `devcontainer exec` — see the module
 * comment on devcontainer-exec.ts for why (the Windows `.cmd` shim would force
 * `shell: true` and disable agent detaching).
 */

/** A host path prefix and its equivalent inside the container. */
export interface ContainerPathMapping {
  hostPrefix: string;
  containerPrefix: string;
}

export interface ContainerWrapOptions {
  handle: DevcontainerHandle;
  /**
   * Host->container path mappings applied to every argument. At minimum this
   * carries the worktree (host path -> remoteWorkspaceFolder); the agent profile
   * directory is added when credentials are mounted.
   */
  pathMappings: ContainerPathMapping[];
  /**
   * Env the CONTAINER needs, merged OVER the forwarded host env. Carries
   * `CLAUDE_CONFIG_DIR` for the narrow profile mount (#133/#134).
   */
  containerEnv?: Record<string, string>;
  /**
   * HOST path of the container's own MCP config (#136), substituted for whatever
   * the provider chose.
   *
   * The provider builds its launch config BEFORE containerization is known, so it
   * always emits the host STDIO config — which names a command that does not exist
   * in the container. Rewriting it here keeps every provider container-agnostic
   * instead of threading container state back into launch-config assembly. The
   * value is a host path because it still goes through the normal path
   * translation below (it lives in the mounted host temp dir).
   */
  containerMcpConfigPath?: string;
}

/**
 * Flags whose VALUE is the next argument and which name an MCP config file.
 * Claude takes `--mcp-config <path>`; Copilot takes `--additional-mcp-config @<path>`.
 */
const MCP_CONFIG_FLAGS = new Set(["--mcp-config", "--additional-mcp-config"]);

/**
 * Replace the MCP config path with the container's own, preserving Copilot's `@`
 * prefix convention. Returns the args unchanged when no substitute was supplied.
 */
export function substituteMcpConfigArg(args: string[], containerMcpConfigPath?: string): string[] {
  if (!containerMcpConfigPath) return args;
  return args.map((arg, index) => {
    const flag = args[index - 1];
    if (!flag || !MCP_CONFIG_FLAGS.has(flag)) return arg;
    return arg.startsWith("@") ? `@${containerMcpConfigPath}` : containerMcpConfigPath;
  });
}

/** Case-insensitive, separator-insensitive comparison key for a Windows-or-POSIX path. */
function normalizeForCompare(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

/**
 * Replace any host path prefix appearing ANYWHERE in an argument with its
 * container equivalent.
 *
 * Substring (not whole-string) replacement is required because providers emit
 * paths embedded in larger arguments — `--mcp-config=C:\...\mcp.json`,
 * `--settings C:\Users\me\.claude\settings_x.json`. Matching is done on a
 * normalized copy so `C:\foo` and `C:/foo` both hit, while the replacement is
 * spliced into the ORIGINAL string by index so untouched regions keep their
 * exact bytes.
 *
 * Longest prefix wins, so a nested mapping (worktree inside repo root) can't be
 * shadowed by a shorter one.
 */
export function translateHostPathsInArg(arg: string, mappings: ContainerPathMapping[]): string {
  const ordered = [...mappings].sort((a, b) => b.hostPrefix.length - a.hostPrefix.length);
  const haystack = normalizeForCompare(arg);
  for (const mapping of ordered) {
    const needle = normalizeForCompare(mapping.hostPrefix);
    if (needle.length === 0) continue;
    const index = haystack.indexOf(needle);
    if (index === -1) continue;
    const head = arg.slice(0, index);
    const tail = arg.slice(index + needle.length).replace(/\\/g, "/");
    return `${head}${mapping.containerPrefix}${tail}`;
  }
  return arg;
}

/**
 * The agent binary as the CONTAINER knows it.
 *
 * Providers resolve their command against the HOST before launch — on Windows
 * `claude-provider.ts` runs `where claude.exe` and hands back an absolute path
 * like `C:\Users\me\.local\bin\claude.exe`. Passing that into `docker exec`
 * fails with exit 127 ("executable file not found in $PATH"), because the
 * container has its own toolchain at its own paths.
 *
 * Path mappings cannot fix this: the host binary lives outside the worktree and
 * outside the mounted profile, so there is nothing to map it onto. The correct
 * container command is the bare program name, resolved against the container's
 * own PATH — with the Windows executable suffix dropped.
 */
export function containerCommandFor(command: string): string {
  const looksLikePath = /[\\/]/.test(command) || /^[a-zA-Z]:/.test(command);
  if (!looksLikePath) return command;
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "");
}

/**
 * Env var name prefixes that are meaningful to an agent regardless of which
 * machine it runs on — credentials, endpoints and board wiring.
 */
const FORWARDED_ENV_PREFIXES = [
  "ANTHROPIC_",
  "CLAUDE_",
  "CODEX_",
  "COPILOT_",
  "PI_",
  "KANBAN_",
  "AGENTIC_",
];

/** Exact names outside the prefix scheme that still need to cross the boundary. */
const FORWARDED_ENV_NAMES = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

export function shouldForwardEnvToContainer(key: string): boolean {
  if (FORWARDED_ENV_NAMES.has(key)) return true;
  return FORWARDED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Docker `-e KEY=VALUE` pairs, restricted to env that is portable across the
 * host/container boundary.
 *
 * `buildSpawnEnv()` hands back a FULL copy of the host `process.env` (with the
 * credential-bleed guard applied) — including Windows `PATH`, `HOME`,
 * `USERPROFILE`, `SystemRoot` and friends. Forwarding those wholesale
 * OVERWRITES the container's own values: a live containerized launch died with
 * exit 127, `exec: "claude": executable file not found in $PATH`, even though
 * the binary was installed and on the container's PATH — because `-e PATH=C:\…`
 * replaced the Linux PATH with a Windows one.
 *
 * An allowlist rather than a denylist: the container legitimately OWNS its
 * environment, so anything describing the host is wrong by default, and a new
 * host var can't silently start leaking in.
 */
function buildEnvFlags(
  env: Record<string, string>,
  pathMappings: ContainerPathMapping[],
  containerEnv: Record<string, string> = {},
): string[] {
  const flags: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!shouldForwardEnvToContainer(key)) continue;
    if (key in containerEnv) continue; // the container's own value wins
    // Forwarded env VALUES get the same host->container path translation as args.
    // Without it a var naming a host location (CLAUDE_CONFIG_DIR pointing at a
    // profile dir, KANBAN_* paths) crosses the boundary verbatim and names a path
    // that does not exist inside — the same class of failure as the `-e PATH=C:\…`
    // exit-127 incident above, but silent instead of fatal.
    flags.push("-e", `${key}=${translateHostPathsInArg(value, pathMappings)}`);
  }
  for (const [key, value] of Object.entries(containerEnv)) {
    flags.push("-e", `${key}=${value}`);
  }
  return flags;
}

/**
 * Wrap a launch config so it executes inside `handle`'s container.
 *
 * `useShell` is forced false: `docker` is a real executable on every platform, so
 * the agent keeps the detached + stdio-to-file behaviour that `shouldDetachAgent`
 * grants only to non-shell spawns.
 *
 * `-i` keeps stdin attached, which the prompt-on-stdin providers require.
 */
export function wrapLaunchConfigForContainer(
  config: AgentLaunchConfig,
  options: ContainerWrapOptions,
): AgentLaunchConfig {
  const { handle, pathMappings, containerEnv, containerMcpConfigPath } = options;
  // Substitute BEFORE translating: the container config lives in the mounted host
  // temp dir, so the substituted path still needs its host prefix rewritten.
  const translatedArgs = substituteMcpConfigArg(config.args, containerMcpConfigPath).map((arg) =>
    translateHostPathsInArg(arg, pathMappings),
  );
  const translatedCommand = containerCommandFor(config.command);

  const dockerArgs = [
    "exec",
    "-i",
    "-u",
    handle.remoteUser,
    "-w",
    handle.remoteWorkspaceFolder,
    ...buildEnvFlags(config.env, pathMappings, containerEnv),
    handle.containerId,
    translatedCommand,
    ...translatedArgs,
  ];

  return {
    ...config,
    command: "docker",
    args: dockerArgs,
    useShell: false,
    // The env now travels INSIDE the container via -e flags; the docker CLI
    // itself needs only the ambient host env to reach the daemon.
    env: {},
  };
}
