import { execErrorMessage, execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { dockerExec } from "@agentic-kanban/shared/lib/docker-exec";
import { hasDevcontainerConfig } from "@agentic-kanban/shared/lib/devcontainer-exec";
import {
  sameHostPath,
  workspaceVolumePrefix,
} from "@agentic-kanban/shared/lib/container-dep-volumes";

/**
 * Docker-level INVENTORY of what a workspace already has running, plus the removal of it.
 *
 * Split out of `devcontainer-workspace.service.ts` under #819. The seam was verified by
 * CONSUMERS, not by identifier vocabulary — the tool-computed seams for that file were
 * `dockerexec` / `worktreepath` / `source`, which are an imported function, a parameter
 * name and a JSON field:
 *
 *  - `reapWorkspaceContainer` is imported by exactly three modules — the three teardown
 *    paths `workspace-cleanup.service.ts`, `workspace-create.service.ts` and
 *    `workspace-resource-release.ts` — and none of them imports anything from the
 *    provisioning half. The provisioning consumers (`workspace-provision.service.ts`,
 *    `session-manager/devcontainer-launch.ts`, `startup/startup-tasks.ts`,
 *    `agent-dispatch.service.ts`) import nothing from here. Genuinely disjoint sets.
 *  - The dependency runs ONE WAY: provisioning calls `recreateStaleProfileContainers`
 *    before `devcontainer up` (#155); nothing here calls back. No cycle, and no shared
 *    state to tear — the original module has no module-level mutable state at all.
 *  - This half speaks only to the `docker` CLI (`ps` / `inspect` / `rm` /
 *    `volume ls|rm`) and needs none of provisioning's profile seeding, MCP bridge,
 *    devcontainer CLI or git configuration. Its imports are a strict subset.
 *
 * `chownDependencyVolumes` is deliberately NOT here, despite #819's hypothesis grouping
 * it with reaping: it takes a live `DevcontainerHandle`, its only caller is
 * `provisionContainerForWorkspace`, and it is part of bringing a container UP.
 */

/**
 * Find containers already up for this worktree whose mounted `.claude` profile
 * directory does NOT match `expectedProfileHostDir` (#155).
 *
 * `devcontainer up` reports success for an existing container without re-applying
 * `--mount`, so the only way to tell whether a stale container is about to be
 * silently reused is to inspect what is ACTUALLY mounted right now.
 */
export async function findStaleProfileContainers(
  worktreePath: string,
  expectedProfileHostDir: string,
): Promise<string[]> {
  const containers = await findWorkspaceContainers(worktreePath);
  if (containers.length === 0) return [];

  const stale: string[] = [];
  for (const containerId of containers) {
    const inspect = await dockerExec(["inspect", "--format", "{{json .Mounts}}", containerId]);
    if (!execSucceeded(inspect)) continue;
    let mounts: Array<{ Destination?: string; Source?: string }>;
    try {
      mounts = JSON.parse(inspect.stdout.trim()) as Array<{ Destination?: string; Source?: string }>;
    } catch {
      continue;
    }
    const claudeMount = mounts.find((m) => m.Destination?.endsWith("/.claude"));
    // No `.claude` mount at all (host-run pre-#133 container, or inspect shape
    // changed) — nothing to compare against, so don't treat it as stale.
    if (!claudeMount?.Source) continue;
    if (!sameHostPath(claudeMount.Source, expectedProfileHostDir)) {
      stale.push(containerId);
    }
  }
  return stale;
}

/**
 * Remove any container already up for this worktree that is mounted with a
 * DIFFERENT profile than `expectedProfileHostDir` resolves to, so the following
 * `devcontainer up` creates a fresh container with the correct mount instead of
 * silently reusing stale credentials (#155). Best-effort, like the rest of
 * provisioning: a removal failure is logged and provisioning proceeds — worst
 * case is the pre-existing stale-reuse bug, not a failed workspace.
 */
export async function recreateStaleProfileContainers(
  worktreePath: string,
  expectedProfileHostDir: string,
): Promise<void> {
  const stale = await findStaleProfileContainers(worktreePath, expectedProfileHostDir);
  if (stale.length === 0) return;

  console.warn(
    `[devcontainer] container(s) for ${worktreePath} are mounted with a DIFFERENT Claude ` +
      `profile than this launch resolved (expected ${expectedProfileHostDir}) — recreating ` +
      `rather than silently reusing the stale profile mount (#155): ${stale.map((id) => id.slice(0, 12)).join(", ")}`,
  );
  for (const containerId of stale) {
    const removed = await dockerExec(["rm", "-f", containerId]);
    if (!execSucceeded(removed)) {
      console.warn(
        `[devcontainer] could not remove stale-profile container ${containerId.slice(0, 12)}: ` +
          `${execErrorMessage(removed)} — the next 'up' may reuse it with the wrong profile.`,
      );
    }
  }
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
      if (execSucceeded(removed)) containersRemoved++;
      else
        console.warn(
          `[devcontainer] could not remove container ${containerId.slice(0, 12)}: ${execErrorMessage(removed)}`,
        );
    }

    if (workspaceId) {
      for (const volume of await findWorkspaceVolumes(workspaceId)) {
        const removed = await dockerExec(["volume", "rm", volume]);
        if (execSucceeded(removed)) volumesRemoved++;
        else
          console.warn(
            `[devcontainer] could not remove volume ${volume}: ${execErrorMessage(removed)}`,
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
  if (!execSucceeded(result)) return [];
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
  if (!execSucceeded(result)) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    // Prefix match, NOT the `--filter name=` substring match, which would also
    // match a volume whose name merely contains the prefix.
    .filter((name) => name.startsWith(prefix));
}
