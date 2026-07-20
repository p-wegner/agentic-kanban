import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { dockerExec } from "@agentic-kanban/shared/lib/docker-exec";
import {
  devcontainerAvailable,
  devcontainerUp,
  hasDevcontainerConfig,
  type DevcontainerHandle,
  type DevcontainerMount,
} from "@agentic-kanban/shared/lib/devcontainer-exec";
import {
  buildDependencyVolumes,
  deriveDependencyDirs,
  predictRemoteWorkspaceFolder,
  sameHostPath,
  workspaceVolumePrefix,
  type DependencyVolume,
} from "@agentic-kanban/shared/lib/container-dep-volumes";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import {
  HOST_GATEWAY_HOSTNAME,
  provisionContainerProfile,
  transcriptMount,
  writeContainerMcpConfig,
} from "./container-profile.service.js";
import { ensureMcpHttpBridge } from "./mcp-http-bridge.service.js";
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
  /** Dependency directories relocated onto named volumes (#138). */
  dependencyVolumes: DependencyVolume[];
  /**
   * Env the CONTAINER needs, merged over the (host) launch env by the wrapper.
   * Carries `CLAUDE_CONFIG_DIR` pointing at the container-side profile mount (#133/#134).
   */
  containerEnv: Record<string, string>;
  /** Host path of the container's HTTP MCP config (#136); undefined = no board tools. */
  containerMcpConfigPath?: string;
}

export interface ProvisionOptions {
  /** The `devcontainer_builders` setting. */
  enabled: boolean;
  worktreePath: string;
  /**
   * Scopes the dependency volumes (#138). Omit to skip them entirely — the
   * container still comes up, with dependencies on the bind mount as before.
   */
  workspaceId?: string;
  /** The project's `symlink_dirs` (raw column or parsed), naming dependency directories. */
  symlinkDirs?: string | string[] | null;
  /** Selected Claude profile name; keys the narrow profile directory (#133). */
  claudeProfile?: string;
  /** An OAuth subscription's `CLAUDE_CONFIG_DIR`, when one is in play — the seed source. */
  claudeConfigDir?: string;
  /** A settings-file profile whose `settings_<name>.json` must also be seeded. */
  settingsProfile?: string;
  /** Overridable for tests; defaults to the host user's home. */
  hostHome?: string;
  /** Overridable for tests; defaults to the host temp directory. */
  hostTmp?: string;
}

/** The container-side home directory for a given remote user. */
function containerHomeFor(remoteUser: string): string {
  return remoteUser === "root" ? "/root" : `/home/${remoteUser}`;
}

/**
 * The Claude config directory bind-mounted into the container (#133).
 *
 * `source` is the NARROW, board-owned profile seeded by
 * `provisionContainerProfile` — credentials, settings and `.claude.json` only —
 * NOT the host's `~/.claude`, which carries every other profile's credentials and
 * thousands of past transcripts. See container-profile.service.ts for the
 * credential/refresh policy.
 *
 * A directory (not a single-file) mount is required: credential refresh rewrites
 * `.credentials.json` via atomic rename, which would break a file bind mount.
 */
function profileMount(narrowProfileDir: string, remoteUser: string) {
  return {
    source: narrowProfileDir.replace(/\\/g, "/"),
    target: `${containerHomeFor(remoteUser)}/.claude`,
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
  const {
    enabled,
    worktreePath,
    workspaceId,
    symlinkDirs,
    claudeProfile,
    claudeConfigDir,
    settingsProfile,
    hostHome = homedir(),
    hostTmp = tmpdir(),
  } = options;
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

  // Dependency volumes must be passed INTO `up`, but the real
  // remoteWorkspaceFolder is only reported afterwards — so predict it, then
  // verify against the handle below.
  const predictedFolder = predictRemoteWorkspaceFolder(worktreePath);
  const dependencyVolumes = workspaceId
    ? buildDependencyVolumes(
        workspaceId,
        deriveDependencyDirs({ worktreePath, symlinkDirs }),
        predictedFolder,
      )
    : [];

  // Seed the narrow profile (#133) — credentials/settings/.claude.json only,
  // reseeded every provision so the container's copy tracks the host's.
  const narrowProfile = provisionContainerProfile({
    sourceDir: claudeConfigDir ?? join(hostHome, ".claude"),
    profileKey: claudeProfile ?? "default",
    settingsProfile,
    hostHome,
  });

  // remoteUser is only known AFTER `up` resolves the config, but the mounts must
  // be passed IN. "node" covers the devcontainer images in practice; a mismatch
  // surfaces as an unauthenticated agent rather than a crash, and the mappings
  // below are rebuilt from the real remoteUser the CLI reports.
  const provisionalHome = containerHomeFor("node");
  const containerConfigDir = `${provisionalHome}/.claude`;
  const provisionalMount = profileMount(narrowProfile.hostDir, "node");
  const mounts: DevcontainerMount[] = [
    provisionalMount,
    // Keep the builder's sessions readable by session-inspector/fleet-analysis by
    // mapping the container's transcript dir onto the host's real one (#133 note).
    transcriptMount({
      worktreePath,
      remoteWorkspaceFolder: predictedFolder,
      containerConfigDir,
      hostHome,
    }),
    hostTmpMount(hostTmp),
    ...dependencyVolumes.map((volume) => ({
      type: "volume" as const,
      source: volume.name,
      target: volume.containerPath,
    })),
  ];

  const handle = await devcontainerUp(worktreePath, { mounts });
  if (!handle) {
    console.warn(
      `[devcontainer] provisioning failed for ${worktreePath} — falling back to host execution.`,
    );
    return undefined;
  }

  // A config with a custom `workspaceFolder` we failed to read would have mounted
  // the volumes outside the worktree: harmless, but the deps would silently stay
  // on the bind mount and #138's symptoms would persist. Say so rather than
  // reporting success.
  if (dependencyVolumes.length > 0 && handle.remoteWorkspaceFolder !== predictedFolder) {
    console.warn(
      `[devcontainer] predicted workspace folder ${predictedFolder} but the CLI reported ` +
        `${handle.remoteWorkspaceFolder} — dependency volumes are mounted at the predicted ` +
        "path and will NOT back the worktree's dependency directories.",
    );
  }

  await configureContainerGit(handle, await resolveHostAutocrlf(worktreePath));
  await chownDependencyVolumes(handle, dependencyVolumes);

  console.log(
    `[devcontainer] builder containerized: worktree=${worktreePath} container=${handle.containerId.slice(0, 12)} user=${handle.remoteUser} cwd=${handle.remoteWorkspaceFolder}` +
      (dependencyVolumes.length > 0
        ? ` depVolumes=${dependencyVolumes.map((v) => v.relPath).join(",")}`
        : ""),
  );

  // Point the builder's MCP client at the board over HTTP (#136). Best-effort: if
  // the listener will not start, the builder runs without board tools rather than
  // failing the workspace — same contract as the rest of provisioning.
  let containerMcpConfigPath: string | undefined;
  if (workspaceId) {
    const mcp = await ensureMcpHttpBridge();
    if (mcp) {
      containerMcpConfigPath = writeContainerMcpConfig({
        hostTmp,
        workspaceId,
        port: mcp.port,
        token: mcp.token,
      });
      await warnIfBoardUnreachable(handle, mcp.port);
    } else {
      console.warn(
        "[devcontainer] board MCP listener unavailable — this containerized builder " +
          "will have no board tools (it cannot use the host stdio config).",
      );
    }
  }

  return {
    handle,
    pathMappings: buildPathMappings(worktreePath, handle, narrowProfile.hostDir, hostTmp),
    dependencyVolumes,
    containerMcpConfigPath,
    // Point the CLI at the mounted profile. This also fixes #134: with
    // CLAUDE_CONFIG_DIR set, the CLI reads `<dir>/.claude.json` instead of
    // `$HOME/.claude.json`, so the "configuration file not found" preamble that
    // every containerized turn printed to stderr goes away.
    containerEnv: { CLAUDE_CONFIG_DIR: `${containerHomeFor(handle.remoteUser)}/.claude` },
  };
}

/**
 * Check the container can actually resolve the host gateway, and say so loudly if not.
 *
 * `host.docker.internal` is provided automatically by Docker Desktop (Windows/macOS)
 * but NOT by a plain Linux docker engine, where it needs
 * `--add-host=host.docker.internal:host-gateway`. The devcontainer CLI has no
 * pass-through for that, so on Linux this is a real limitation rather than something
 * the board can paper over. Without the probe it would present as MCP tools that are
 * merely "pending" forever — the exact silent symptom #136 was filed for.
 */
async function warnIfBoardUnreachable(handle: DevcontainerHandle, port: number): Promise<void> {
  const probe = await dockerExec([
    "exec",
    handle.containerId,
    "getent",
    "hosts",
    HOST_GATEWAY_HOSTNAME,
  ]);
  if (probe.code === 0 && probe.stdout.trim()) return;
  console.warn(
    `[devcontainer] the container cannot resolve ${HOST_GATEWAY_HOSTNAME}, so the board MCP ` +
      `endpoint on :${port} is unreachable and the builder will have NO board tools. ` +
      "Docker Desktop provides this name automatically; a plain Linux engine needs " +
      "`--add-host=host.docker.internal:host-gateway`, which the devcontainer CLI cannot " +
      "pass through — declare it in the repo's devcontainer.json `runArgs` instead.",
  );
}

/**
 * A freshly-created named volume is owned by root, but the agent runs as
 * `remoteUser` — so without this the install fails with EACCES on mkdir, which
 * would be a fresh instance of the very error #138 exists to remove.
 *
 * Best-effort, like the git config: a failure degrades the container rather than
 * failing the workspace.
 */
export async function chownDependencyVolumes(
  handle: DevcontainerHandle,
  volumes: DependencyVolume[],
): Promise<void> {
  if (volumes.length === 0 || handle.remoteUser === "root") return;
  const result = await dockerExec([
    "exec",
    "-u",
    "root",
    handle.containerId,
    "chown",
    handle.remoteUser,
    ...volumes.map((v) => v.containerPath),
  ]);
  if (result.code !== 0) {
    console.warn(
      `[devcontainer] could not chown dependency volumes to ${handle.remoteUser}: ` +
        `${result.stderr.trim() || result.error} — the install may fail with EACCES.`,
    );
  }
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
  narrowProfileDir: string,
  hostTmp: string,
): ContainerPathMapping[] {
  const mount = profileMount(narrowProfileDir, handle.remoteUser);
  return [
    { hostPrefix: worktreePath, containerPrefix: handle.remoteWorkspaceFolder },
    { hostPrefix: narrowProfileDir, containerPrefix: mount.target },
    { hostPrefix: hostTmp, containerPrefix: HOST_TMP_CONTAINER_PATH },
  ];
}

/**
 * Tear down a workspace's container and its dependency volumes (#138).
 *
 * Both halves are required and ordered: a volume still attached to a container
 * cannot be removed, so reaping the volumes without first removing the container
 * would silently leak every one of them — the failure mode the compose service
 * stacks already had.
 *
 * SCOPING — this runs on a machine that also hosts unrelated containers, so
 * matching must never be broad:
 *  - containers are matched by the devcontainer CLI's own
 *    `devcontainer.local_folder` label, set to the host worktree path;
 *  - volumes are matched by the board-owned `agentic-kanban-deps-<workspaceId>-`
 *    name prefix.
 * Neither can match a co-tenant's resources.
 *
 * Best-effort throughout: teardown failures are logged, never thrown. Losing a
 * worktree because a container would not stop is a worse outcome than a leak.
 */
export async function reapWorkspaceContainer(opts: {
  worktreePath: string;
  workspaceId?: string;
}): Promise<{ containersRemoved: number; volumesRemoved: number }> {
  const { worktreePath, workspaceId } = opts;
  let containersRemoved = 0;
  let volumesRemoved = 0;

  // Gate on the same cheap signal that gates PROVISIONING. Close and merge are hot
  // paths that run for every workspace on every board, while containerized builders
  // are opt-in and off by default — so an unconditional reap would charge every
  // merge two docker CLI round-trips for a container that cannot exist. A worktree
  // that declares no devcontainer was never containerized, and this costs one stat.
  //
  // Edge case: a worktree directory already deleted by an earlier partial cleanup
  // reads as "no devcontainer" and is skipped. Accepted deliberately — the
  // alternative taxes every merge on every project to catch a rare double-cleanup.
  if (!hasDevcontainerConfig(worktreePath)) return { containersRemoved, volumesRemoved };

  try {
    const containers = await findWorkspaceContainers(worktreePath);
    for (const containerId of containers) {
      const removed = await dockerExec(["rm", "-f", containerId]);
      if (removed.code === 0) containersRemoved++;
      else
        console.warn(
          `[devcontainer] could not remove container ${containerId.slice(0, 12)}: ${removed.stderr.trim() || removed.error}`,
        );
    }

    if (workspaceId) {
      for (const volume of await findWorkspaceVolumes(workspaceId)) {
        const removed = await dockerExec(["volume", "rm", volume]);
        if (removed.code === 0) volumesRemoved++;
        else
          console.warn(
            `[devcontainer] could not remove volume ${volume}: ${removed.stderr.trim() || removed.error}`,
          );
      }
    }

    if (containersRemoved > 0 || volumesRemoved > 0) {
      console.log(
        `[devcontainer] reaped ${containersRemoved} container(s) and ${volumesRemoved} dependency volume(s) for ${worktreePath}`,
      );
    }
  } catch (error) {
    console.warn(`[devcontainer] teardown failed for ${worktreePath}:`, error);
  }

  return { containersRemoved, volumesRemoved };
}

/**
 * Containers the devcontainer CLI created for this worktree, found via the label
 * it stamps on every container it brings up.
 *
 * Lists all labelled containers and compares in JS rather than passing the path to
 * `--filter`, because that filter is an exact string match against a path the CLI
 * has already normalized — see `sameHostPath`.
 */
export async function findWorkspaceContainers(worktreePath: string): Promise<string[]> {
  const result = await dockerExec([
    "ps",
    "-a",
    "--filter",
    "label=devcontainer.local_folder",
    "--format",
    '{{.ID}}\t{{.Label "devcontainer.local_folder"}}',
  ]);
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter(([, folder]) => folder && sameHostPath(folder, worktreePath))
    .map(([id]) => id!);
}

export async function findWorkspaceVolumes(workspaceId: string): Promise<string[]> {
  const prefix = workspaceVolumePrefix(workspaceId);
  const result = await dockerExec(["volume", "ls", "--format", "{{.Name}}"]);
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    // Prefix match, NOT the `--filter name=` substring match, which would also
    // match a volume whose name merely contains the prefix.
    .filter((name) => name.startsWith(prefix));
}
