import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { dockerExec } from "@agentic-kanban/shared/lib/docker-exec";
import {
  devcontainerAvailable,
  devcontainerUp,
  hasDevcontainerConfig,
  type DevcontainerHandle,
} from "@agentic-kanban/shared/lib/devcontainer-exec";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import type { ContainerPathMapping } from "./agent-provider/container-wrap.js";

/**
 * Provisions the devcontainer a builder agent runs inside.
 *
 * Design contract: containerization is BEST-EFFORT. Every prerequisite that is
 * missing (setting off, no devcontainer.json, no CLI, provisioning failure)
 * resolves to `undefined`, and the caller falls back to launching the agent on
 * the host. A container problem must never turn into a failed workspace.
 */

export interface ContainerProvision {
  handle: DevcontainerHandle;
  pathMappings: ContainerPathMapping[];
}

export interface ProvisionOptions {
  /** The `devcontainer_builders` setting. */
  enabled: boolean;
  worktreePath: string;
  /** Overridable for tests; defaults to the host user's home. */
  hostHome?: string;
  /** Overridable for tests; defaults to the host temp directory. */
  hostTmp?: string;
}

/**
 * The host profile directory bind-mounted into the container so the agent
 * authenticates as the user's normal profile.
 *
 * SECURITY (tracked by #133): this mounts the WHOLE profile read-write, so the
 * agent inside the container can read and overwrite the host's OAuth
 * credentials, settings and transcripts. That gives back much of the isolation
 * containerization is supposed to buy (see docs/decisions/011, which treats
 * agent code as host-root-equivalent today). It is why `devcontainer_builders`
 * ships OFF by default. #133 replaces this with a minimal per-workspace profile.
 *
 * A directory (not a single-file) mount is required: credential refresh rewrites
 * `.credentials.json` via atomic rename, which would break a file bind mount.
 */
function profileMount(hostHome: string, remoteUser: string) {
  const containerHome = remoteUser === "root" ? "/root" : `/home/${remoteUser}`;
  return {
    source: join(hostHome, ".claude").replace(/\\/g, "/"),
    target: `${containerHome}/.claude`,
  };
}

/** Where the host's temp directory is mounted inside the container. */
export const HOST_TMP_CONTAINER_PATH = "/kanban-host-tmp";

/**
 * The board writes per-launch artifacts the agent must read — most importantly
 * the generated MCP config (`<tmpdir>/agentic-kanban-mcp-config.json`) — into the
 * host temp directory. That is neither the worktree nor the profile, so without
 * this mount a containerized launch dies with
 * `Invalid MCP configuration: MCP config file not found`.
 *
 * The mount has to be the DIRECTORY, not the config file: the file is generated
 * by `buildLaunchConfig()` at launch time, which is AFTER provisioning, so there
 * is nothing to bind yet when the container comes up.
 *
 * NOTE (breadth, tracked with #133): this exposes the whole host temp directory,
 * including other sessions' output files, to the agent. It should narrow to a
 * board-owned per-workspace directory when #133 replaces the profile mount.
 */
function hostTmpMount(hostTmp: string) {
  return { source: hostTmp.replace(/\\/g, "/"), target: HOST_TMP_CONTAINER_PATH };
}

/**
 * Line-ending parity between host and container (#132).
 *
 * A Windows checkout puts CRLF on disk (`core.autocrlf=true`). The Linux
 * container's git has no autocrlf, so every CRLF file compares as fully
 * rewritten — measured at 151 of 170 tracked files on the taskflow fixture,
 * which would hand `getWorkingTreeDiff()` the entire repo and make review,
 * conflict detection and merge meaningless.
 *
 * Propagating the host's value makes the container agree with the bytes that are
 * actually on disk, instead of renormalising the repo.
 */
export async function resolveHostAutocrlf(worktreePath: string): Promise<string | undefined> {
  const result = await gitExec(["config", "core.autocrlf"], { cwd: worktreePath });
  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
}

/**
 * Apply the git configuration a bind-mounted host worktree needs to be usable
 * inside the container. Best-effort: a failure here degrades diff fidelity but
 * must not abort the launch.
 */
export async function configureContainerGit(
  handle: DevcontainerHandle,
  autocrlf: string | undefined,
): Promise<void> {
  const run = (gitArgs: string[]) =>
    dockerExec([
      "exec",
      "-u",
      handle.remoteUser,
      handle.containerId,
      "git",
      "config",
      "--global",
      ...gitArgs,
    ]);

  // The bind-mounted worktree is owned by a different uid than the container
  // user, which makes git refuse to operate on it as "dubious ownership".
  await run(["--add", "safe.directory", handle.remoteWorkspaceFolder]);

  if (autocrlf) {
    await run(["core.autocrlf", autocrlf]);
  }
}

/**
 * Bring up the worktree's devcontainer and return the handle plus the host->container
 * path mappings the launch wrapper needs. Returns undefined to mean "run on the host".
 */
export async function provisionContainerForWorkspace(
  options: ProvisionOptions,
): Promise<ContainerProvision | undefined> {
  const { enabled, worktreePath, hostHome = homedir(), hostTmp = tmpdir() } = options;
  if (!enabled) return undefined;

  if (!hasDevcontainerConfig(worktreePath)) {
    // Not an error: most repos have no devcontainer, and those simply run on the host.
    return undefined;
  }

  if (!(await devcontainerAvailable())) {
    console.warn(
      `[devcontainer] devcontainer_builders is on and ${worktreePath} declares a devcontainer, ` +
        "but the @devcontainers/cli is not installed (npm i -g @devcontainers/cli) — " +
        "falling back to host execution.",
    );
    return undefined;
  }

  // remoteUser is only known AFTER `up` resolves the config, but the profile
  // mount must be passed IN. "node" covers the devcontainer images in practice;
  // a mismatch surfaces as an unauthenticated agent rather than a crash, and the
  // mapping below is rebuilt from the real remoteUser the CLI reports.
  const provisionalMount = profileMount(hostHome, "node");
  const handle = await devcontainerUp(worktreePath, {
    mounts: [provisionalMount, hostTmpMount(hostTmp)],
  });
  if (!handle) {
    console.warn(
      `[devcontainer] provisioning failed for ${worktreePath} — falling back to host execution.`,
    );
    return undefined;
  }

  await configureContainerGit(handle, await resolveHostAutocrlf(worktreePath));

  console.log(
    `[devcontainer] builder containerized: worktree=${worktreePath} container=${handle.containerId.slice(0, 12)} user=${handle.remoteUser} cwd=${handle.remoteWorkspaceFolder}`,
  );

  return { handle, pathMappings: buildPathMappings(worktreePath, handle, hostHome, hostTmp) };
}

/**
 * Host->container path mappings applied to the agent's arguments.
 *
 * Both are required: the worktree (the agent's cwd and every file path it is
 * handed) and the profile directory (Claude's `--settings` flag points at
 * `~/.claude/settings_<profile>.json`, a host path that means nothing inside).
 */
export function buildPathMappings(
  worktreePath: string,
  handle: DevcontainerHandle,
  hostHome: string,
  hostTmp: string,
): ContainerPathMapping[] {
  const mount = profileMount(hostHome, handle.remoteUser);
  return [
    { hostPrefix: worktreePath, containerPrefix: handle.remoteWorkspaceFolder },
    { hostPrefix: join(hostHome, ".claude"), containerPrefix: mount.target },
    { hostPrefix: hostTmp, containerPrefix: HOST_TMP_CONTAINER_PATH },
  ];
}
