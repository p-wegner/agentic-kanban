/**
 * Devcontainer provisioning + isolation-downgrade surfacing for a session launch,
 * extracted from session-lifecycle.ts (#160). Every containerization prerequisite
 * failure used to fall back to host execution with only a console.warn — for a
 * feature whose purpose is isolation, "container requested, host delivered" must
 * be visible: persisted on the workspace and posted as a workspace comment. In
 * `devcontainer_strict` mode, a downgrade refuses the launch instead.
 */
import { parseBoolSetting } from "@agentic-kanban/shared/lib/settings-registry";
import type { Database } from "../../db/index.js";
import * as lifecycleRepo from "../../repositories/session-lifecycle.repository.js";
import { updateWorkspaceIsolationDowngrade } from "../../repositories/workspace-isolation.repository.js";
import {
  provisionContainerForWorkspace,
  DevcontainerIsolationRefusedError,
  type ContainerProvision,
} from "../devcontainer-workspace.service.js";
import { WorkspaceError } from "../workspace-internals.js";
import type { ProviderName } from "../agent-provider.js";
import type { SessionState } from "./types.js";

export interface ResolveContainerProvisionParams {
  db: Database;
  state: SessionState;
  sessionId: string;
  workspaceId: string;
  projectId: string;
  effectiveWorkingDir: string;
  profile?: { provider: ProviderName; name: string };
  launchProfile?: { provider: ProviderName; name: string };
  effectiveExtraEnv?: Record<string, string>;
}

export interface ResolveContainerProvisionResult {
  devcontainerEnabled: boolean;
  containerProvision?: ContainerProvision;
  /** Set when isolation was requested but the launch fell back to the host. */
  isolationDowngradeReason?: string;
}

/**
 * Best-effort by default: any missing prerequisite resolves to running on the
 * host. In strict mode, throws `WorkspaceError` (code `ISOLATION_REFUSED`)
 * instead — after cleaning up the session row this launch already inserted, so
 * a refused launch never lingers as "running" with no process behind it.
 */
export async function resolveContainerProvision(
  params: ResolveContainerProvisionParams,
): Promise<ResolveContainerProvisionResult> {
  const { db, state, sessionId, workspaceId, projectId, effectiveWorkingDir, profile, launchProfile, effectiveExtraEnv } = params;

  const devcontainerEnabled = parseBoolSetting(
    "devcontainer_builders",
    await lifecycleRepo.getPreferenceValue("devcontainer_builders", db),
  );
  if (!devcontainerEnabled) return { devcontainerEnabled };

  try {
    const strict = parseBoolSetting(
      "devcontainer_strict",
      await lifecycleRepo.getPreferenceValue("devcontainer_strict", db),
    );
    // Only read the project when the feature is on — this is the default-off
    // path for every launch, and it should not pay for a lookup it won't use.
    const projectInfo = projectId ? await lifecycleRepo.getProjectPreflightInfo(projectId, db) : null;
    const result = await provisionContainerForWorkspace({
      enabled: true,
      worktreePath: effectiveWorkingDir,
      workspaceId,
      symlinkDirs: projectInfo?.symlinkEnabled ? projectInfo.symlinkDirs : null,
      // Seed the narrow container profile from whatever this launch actually
      // authenticates with (#133). An OAuth subscription resolved above put its
      // CLAUDE_CONFIG_DIR in effectiveExtraEnv and reset launchProfile to
      // "default"; a settings-file profile keeps its name and needs its
      // settings_<name>.json seeded too.
      claudeProfile: profile?.name ?? "default",
      claudeConfigDir: effectiveExtraEnv?.CLAUDE_CONFIG_DIR,
      settingsProfile: launchProfile?.name !== "default" ? launchProfile?.name : undefined,
      strict,
    });
    return { devcontainerEnabled, containerProvision: result.provision, isolationDowngradeReason: result.downgradeReason };
  } catch (err) {
    if (err instanceof DevcontainerIsolationRefusedError) {
      await lifecycleRepo
        .updateSessionStoppedWithStats(sessionId, new Date().toISOString(), null, JSON.stringify({ failureReason: err.message }), db)
        .catch(() => {});
      state.sessionContexts.delete(sessionId);
      state.turnStates.delete(sessionId);
      state.sessionProviders.delete(sessionId);
      throw new WorkspaceError(err.message, "CONFLICT", { code: "ISOLATION_REFUSED" });
    }
    console.warn(`[devcontainer] provisioning threw for sessionId=${sessionId} — running on host`, err);
    return { devcontainerEnabled };
  }
}

/**
 * Persist a downgrade (flag + reason) onto the workspace and post a workspace
 * comment naming it — or clear a stale downgrade once a later launch either
 * containerizes cleanly OR no longer requests isolation at all (feature toggled
 * off). Clearing must NOT be gated on `devcontainerEnabled`: if it were, a
 * workspace downgraded while the feature was on would keep showing the
 * downgrade warning forever after the user turns `devcontainer_builders` back
 * off, even though no isolation is being requested (or silently skipped) on
 * any subsequent launch. Best-effort: a write/comment failure must not turn an
 * already-decided host fallback into a launch failure.
 */
export function surfaceIsolationDowngrade(params: {
  db: Database;
  workspaceId: string;
  isolationDowngradeReason?: string;
  wasAlreadyDowngraded: boolean;
}): void {
  const { db, workspaceId, isolationDowngradeReason, wasAlreadyDowngraded } = params;

  if (isolationDowngradeReason) {
    updateWorkspaceIsolationDowngrade(workspaceId, true, isolationDowngradeReason, db)
      .catch((err) => console.error(`Failed to persist isolation downgrade: workspaceId=${workspaceId}`, err));
    void (async () => {
      try {
        const { createDiffComment } = await import("../../repositories/session.repository.js");
        await createDiffComment(
          workspaceId,
          {
            filePath: ".devcontainer-isolation",
            body:
              "⚠️ **Isolation downgrade**: containerized isolation was requested for this workspace, " +
              `but the builder launched on the HOST instead.\n\n_Reason_: ${isolationDowngradeReason}`,
            lineNumOld: null,
            lineNumNew: null,
          },
          db,
        );
      } catch (err) {
        console.warn(`[devcontainer] failed to post isolation-downgrade comment: workspaceId=${workspaceId}`, err);
      }
    })();
  } else if (wasAlreadyDowngraded) {
    updateWorkspaceIsolationDowngrade(workspaceId, false, null, db)
      .catch((err) => console.error(`Failed to clear isolation downgrade: workspaceId=${workspaceId}`, err));
  }
}
