import { execErrorMessage } from "@agentic-kanban/shared/lib/exec-result";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseBoolSetting } from "@agentic-kanban/shared/lib/settings-registry";
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
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { recreateStaleProfileContainers } from "./devcontainer-workspace/container-inventory.js";

/**
 * Container INVENTORY and teardown moved to `devcontainer-workspace/container-inventory.ts`
 * (#819) — see that module's header for the consumer analysis that justified the seam.
 * Re-exported here so no call site changed in the splitting commit.
 */
export {
  findStaleProfileContainers,
  findWorkspaceContainers,
  findWorkspaceVolumes,
  reapWorkspaceContainer,
} from "./devcontainer-workspace/container-inventory.js";

/**
 * Provisions the devcontainer a builder agent runs inside.
 *
 * Design contract: containerization is BEST-EFFORT BY DEFAULT. Every prerequisite
 * that is missing (setting off, no devcontainer.json, no CLI, provisioning
 * failure) resolves to `{ provision: undefined }`, and the caller falls back to
 * launching the agent on the host. A container problem must never turn into a
 * failed workspace UNLESS `strict` is set (#160) — in that mode, a downgrade
 * (CLI missing / provisioning failed; NOT "off" or "no devcontainer declared",
 * which are not downgrades) refuses the launch via
 * `DevcontainerIsolationRefusedError` instead of falling back silently.
 *
 * Either way, a downgrade is never silent: `result.downgradeReason` is set
 * whenever isolation was requested (`enabled`) and a devcontainer was declared,
 * but the container did not come up — the caller persists it onto the workspace
 * and posts a workspace comment so "container requested, host delivered" is
 * visible instead of a console.warn only.
 */

/** Thrown by `provisionContainerForWorkspace` in strict mode instead of falling back to the host. */
export class DevcontainerIsolationRefusedError extends Error {
  constructor(public readonly reason: string) {
    super(`Containerized isolation was requested (strict mode) but is unavailable: ${reason}`);
    this.name = "DevcontainerIsolationRefusedError";
  }
}

export interface ContainerProvisionResult {
  provision?: ContainerProvision;
  /** Set when isolation was requested but the launch fell back to (or, in strict mode, refused) the host. */
  downgradeReason?: string;
}

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
  /** The `devcontainer_strict` setting: refuse the launch instead of falling back to host (#160). */
  strict?: boolean;
}

/**
 * The one place that turns "this project/launch, right now" into `ProvisionOptions` (#555).
 *
 * Both callers of `provisionContainerForWorkspace` — setup time
 * (`workspace-provision.service.ts`) and launch time
 * (`session-manager/devcontainer-launch.ts`) — must produce the SAME options for
 * the same workspace: `devcontainer up` reuses an existing container and its
 * CREATION-TIME mounts win, so a setup call that resolved `symlinkDirs`/`strict`
 * differently freezes the container on the wrong shape and the launch-time call
 * meeting it can only recreate or accept it (#155, #577). They used to build the
 * object by hand, one field at a time, which is exactly how that drift happened.
 *
 * Returns `null` when containerization is off, so the caller can skip the work it
 * would otherwise pay for; `resolveSymlink` is only invoked when it is on.
 */
export interface DevcontainerProvisionRequest {
  worktreePath: string;
  workspaceId?: string;
  /** Read a global preference (repo/service, whichever the caller already has). */
  readPreference: (key: string) => Promise<string | null | undefined>;
  /**
   * The project's symlink config, resolved lazily — dependency volumes are mounted
   * only when the feature is ON for the project (#577), never from `dirs` alone.
   */
  resolveSymlink?: () => Promise<{ enabled: boolean; dirs: string | string[] | null } | null>;
  /** The profile this workspace's agent will actually authenticate as (#133/#155). */
  profile?: { claudeProfile?: string; claudeConfigDir?: string; settingsProfile?: string };
  hostHome?: string;
  hostTmp?: string;
}

export async function resolveDevcontainerProvisionOptions(
  request: DevcontainerProvisionRequest,
): Promise<ProvisionOptions | null> {
  const enabled = parseBoolSetting("devcontainer_builders", (await request.readPreference("devcontainer_builders")) ?? null);
  if (!enabled) return null;

  const strict = parseBoolSetting("devcontainer_strict", (await request.readPreference("devcontainer_strict")) ?? null);
  const symlink = request.resolveSymlink ? await request.resolveSymlink() : null;

  return {
    enabled: true,
    strict,
    worktreePath: request.worktreePath,
    workspaceId: request.workspaceId,
    symlinkDirs: symlink?.enabled ? symlink.dirs : null,
    claudeProfile: request.profile?.claudeProfile,
    claudeConfigDir: request.profile?.claudeConfigDir,
    settingsProfile: request.profile?.settingsProfile,
    hostHome: request.hostHome,
    hostTmp: request.hostTmp,
  };
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
 * path mappings the launch wrapper needs. `provision` is undefined to mean "run on
 * the host"; `downgradeReason` is set alongside that whenever isolation was actually
 * requested (not just "off" / "no devcontainer declared") and did not happen.
 *
 * Throws `DevcontainerIsolationRefusedError` instead of falling back when
 * `options.strict` is set and a downgrade would otherwise occur (#160).
 */
export async function provisionContainerForWorkspace(
  options: ProvisionOptions,
): Promise<ContainerProvisionResult> {
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
    strict = false,
  } = options;
  if (!enabled) return {};

  if (!hasDevcontainerConfig(worktreePath)) {
    // Not an error: most repos have no devcontainer, and those simply run on the host.
    return {};
  }

  const refuseOrDowngrade = (reason: string): ContainerProvisionResult => {
    if (strict) throw new DevcontainerIsolationRefusedError(reason);
    console.warn(`[devcontainer] ${reason} — falling back to host execution.`);
    return { downgradeReason: reason };
  };

  if (!(await devcontainerAvailable())) {
    return refuseOrDowngrade(
      `devcontainer_builders is on and ${worktreePath} declares a devcontainer, but the ` +
        "@devcontainers/cli is not installed (npm i -g @devcontainers/cli)",
    );
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
  // reseeded every provision so the container's copy tracks the host's. Scoped to
  // this workspace (#157) so provisioning a sibling workspace on the same profile
  // never reseeds over a live container's just-rotated credentials.
  const narrowProfile = provisionContainerProfile({
    sourceDir: claudeConfigDir ?? join(hostHome, ".claude"),
    profileKey: claudeProfile ?? "default",
    workspaceId,
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

  // `devcontainer up` reuses an existing container for this worktree, and a
  // creation-time mount cannot be changed by a later `up` call (#155) — so if a
  // container is already running here with a DIFFERENT Claude profile mounted
  // (a prior provision resolved a different profile, or defaulted because it was
  // never told one), reusing it would silently keep the STALE profile's
  // credentials for the container's whole lifetime. Recreate rather than reuse.
  await recreateStaleProfileContainers(worktreePath, narrowProfile.hostDir);

  const handle = await devcontainerUp(worktreePath, { mounts });
  if (!handle) {
    return refuseOrDowngrade(`provisioning failed for ${worktreePath}`);
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
    provision: {
      handle,
      pathMappings: buildPathMappings(worktreePath, handle, narrowProfile.hostDir, hostTmp),
      dependencyVolumes,
      containerMcpConfigPath,
      containerEnv: {
        // Point the CLI at the mounted profile. This also fixes #134: with
        // CLAUDE_CONFIG_DIR set, the CLI reads `<dir>/.claude.json` instead of
        // `$HOME/.claude.json`, so the "configuration file not found" preamble that
        // every containerized turn printed to stderr goes away.
        CLAUDE_CONFIG_DIR: `${containerHomeFor(handle.remoteUser)}/.claude`,
        // The only signal the in-container hook scripts have that they're running inside a
        // builder image rather than on the host — smart-hooks-runner.js reads this to skip
        // host-toolchain quick-checks instead of exec'ing them and failing closed on a host
        // path/binary assumption the image doesn't meet (#158).
        AGENTIC_KANBAN_CONTAINER: "1",
      },
    },
  };
}

/**
 * Rewrite a containerized session's MCP config with the CURRENT bridge port+token
 * (#156).
 *
 * The bridge is per-boot (`mcp-http-bridge.service.ts`) and is torn down on every
 * server shutdown INCLUDING `SIGTERM` (hot-reload), unlike the containerized
 * agent process itself, which is detached and survives. So a session reattached
 * after a restart is left holding a config that names a dead port/token — the
 * new bridge started with a fresh port and token that nothing ever pushes back
 * into the container's mounted config file.
 *
 * The config file lives on the host-temp bind mount (`hostTmpMount`), keyed only
 * by `workspaceId` (see `writeContainerMcpConfig`), so it can be rewritten from
 * the host without touching the container — the same mechanism that makes the
 * mount work in the first place. Call this from the boot-time reattach path for
 * every session that has a persisted `containerId`.
 *
 * Best-effort, matching the rest of provisioning: if the bridge cannot (re)start,
 * resolves undefined and the caller decides whether/how to warn.
 */
export async function refreshContainerMcpConfig(
  workspaceId: string,
  hostTmp: string = tmpdir(),
): Promise<string | undefined> {
  const mcp = await ensureMcpHttpBridge();
  if (!mcp) return undefined;
  return writeContainerMcpConfig({ hostTmp, workspaceId, port: mcp.port, token: mcp.token });
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
  if (execSucceeded(probe) && probe.stdout.trim()) return;
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
  if (!execSucceeded(result)) {
    console.warn(
      `[devcontainer] could not chown dependency volumes to ${handle.remoteUser}: ` +
        `${execErrorMessage(result)} — the install may fail with EACCES.`,
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

