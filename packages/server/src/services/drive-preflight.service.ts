import { getUncommittedTrackedChanges } from "@agentic-kanban/shared/lib/git-service";
import type { Database } from "../db/index.js";
import { getProjectStatuses } from "../repositories/project.repository.js";
import { getProjectRepoAndBranch } from "../repositories/drive-preflight.repository.js";
import { getAllPreferences } from "../repositories/preferences.repository.js";
import { getStackProfile, verifyScriptPrefKey } from "./stack-profile.service.js";
import { parseStrategyBullseyeConfig, selectProviderFromStrategy } from "./strategy-objective.service.js";
import { cooldownKey as claudeCooldownKey } from "./claude-subscription-ring.js";
import { cooldownKey as codexCooldownKey } from "./codex-license-ring.js";
import { getDriveStatus, setDriveEnabled } from "./drive.service.js";
import type { DriveEnablementStatus } from "./drive.service.js";
import { resolveProjectRuntimeConfig } from "./project-runtime-config.service.js";

/**
 * Drive preflight (#807): assert the hands-off prerequisites BEFORE a drive starts.
 *
 * Driving a freshly-prepared project hands-off has a set of prerequisites that, when
 * missing, do not fail loudly — they make the board *stall silently mid-drive*: an empty
 * status set means `POST /api/issues/batch` 400s, a null `defaultBranch` makes auto-start
 * swallow its own error, a dirty main (uncommitted agent-artifact `.gitignore`) blocks
 * every auto-merge, a credit-exhausted provider launches and dies in ~5s. The
 * `drive-new-project` skill encodes this as a human checklist; this service encodes the
 * machine-checkable half as an API/engine gate so the operator gets a verdict — exactly
 * what is missing, and whether it can be auto-repaired — instead of a quiet stall.
 *
 * Each check is independent and reports a {@link PreflightSeverity}:
 * - `block`   — the drive cannot start (or cannot drain) until this is fixed.
 * - `warn`    — the drive can start, but is degraded (e.g. WIP target of 1 = no parallelism).
 * - `ok`      — prerequisite satisfied.
 *
 * Some blockers are *auto-repairable* — `setDriveEnabled` already ensures the coherent pref
 * set, the stack profile, and the verify gate (#806). When {@link runDrivePreflight} is asked
 * to `autoRepair`, it flips Drive on (which performs those repairs) and re-evaluates, so the
 * final report reflects the post-repair state. Checks that need a human (no statuses, null
 * defaultBranch, dirty main, exhausted provider) are reported, never silently worked around.
 */

export type PreflightSeverity = "ok" | "warn" | "block";

export interface PreflightCheck {
  /** Stable machine id for the prerequisite (for UI/tests). */
  id: string;
  /** Human-readable label. */
  label: string;
  severity: PreflightSeverity;
  /** What was found / why it matters — shown to the operator. */
  message: string;
  /** Whether `setDriveEnabled` (the one-switch repair) can fix this without a human. */
  autoRepairable: boolean;
}

export interface DrivePreflightResult {
  projectId: string;
  /** True when no check is at `block` severity — a drive may start. */
  ready: boolean;
  /** True when at least one blocking check is auto-repairable (the caller may retry with autoRepair). */
  repairable: boolean;
  /** Whether an auto-repair pass was performed (and the result reflects the post-repair state). */
  repaired: boolean;
  checks: PreflightCheck[];
  /** Current Drive status (post-repair when repaired). */
  drive: DriveEnablementStatus;
}

function ok(id: string, label: string, message: string): PreflightCheck {
  return { id, label, severity: "ok", message, autoRepairable: false };
}
function block(id: string, label: string, message: string, autoRepairable = false): PreflightCheck {
  return { id, label, severity: "block", message, autoRepairable };
}
function warn(id: string, label: string, message: string, autoRepairable = false): PreflightCheck {
  return { id, label, severity: "warn", message, autoRepairable };
}

/** A profile whose cooldown stamp is in the future is credit-exhausted / rate-limited right now. */
function isProfileCooledDown(
  cooldownPrefKey: string,
  prefMap: Map<string, string>,
  nowMs: number,
): { cooled: boolean; until: string | null } {
  const stamp = prefMap.get(cooldownPrefKey);
  if (!stamp) return { cooled: false, until: null };
  const until = Date.parse(stamp);
  if (Number.isNaN(until) || until <= nowMs) return { cooled: false, until: null };
  return { cooled: true, until: new Date(until).toISOString() };
}

/**
 * Resolve the provider+profile this project's drive will launch with, then check its
 * health (real profile, not exhausted). Reads the Strategy Bullseye first (the single
 * source of truth for the provider default); falls back to the global `provider` +
 * `*_profile` prefs when no strategy policy is configured.
 */
function checkProviderHealth(projectId: string, prefMap: Map<string, string>, now: Date): PreflightCheck {
  let provider: "claude" | "codex" | "copilot" | "pi" = "claude";
  let profileName = "";

  const strategyRaw = prefMap.get(`board_strategy_${projectId}`);
  if (strategyRaw) {
    try {
      const selected = selectProviderFromStrategy(parseStrategyBullseyeConfig(strategyRaw));
      if (selected) {
        provider = selected.provider;
        profileName = selected.profileName;
      }
    } catch {
      /* malformed strategy — fall through to global prefs */
    }
  }
  if (!profileName) {
    const globalProvider = prefMap.get("provider");
    if (globalProvider === "codex" || globalProvider === "copilot" || globalProvider === "pi" || globalProvider === "claude") {
      provider = globalProvider;
    }
    profileName =
      provider === "codex"
        ? prefMap.get("codex_profile") ?? ""
        : provider === "pi"
          ? prefMap.get("pi_profile") ?? ""
        : provider === "copilot"
          ? prefMap.get("copilot_profile") ?? ""
          : prefMap.get("claude_profile") ?? "";
  }

  // A `mock` profile drives against the mock agent — fine for E2E, never a real hands-off drive.
  if (provider === "claude" && profileName === "mock") {
    return block(
      "provider",
      "Provider healthy",
      "Claude profile is `mock` — the drive would run the mock agent, not a real build. Restore a real profile.",
    );
  }

  // Credit-exhaustion / rate-limit: a cooldown stamp in the future means a launch dies in ~5s.
  const nowMs = now.getTime();
  if (provider === "claude" && profileName) {
    const { cooled, until } = isProfileCooledDown(claudeCooldownKey(profileName), prefMap, nowMs);
    if (cooled) {
      return block(
        "provider",
        "Provider healthy",
        `Claude profile \`${profileName}\` is rate-limited until ${until} — starting now would stall. Rotate or wait.`,
      );
    }
  }
  if (provider === "codex" && profileName) {
    const { cooled, until } = isProfileCooledDown(codexCooldownKey(profileName), prefMap, nowMs);
    if (cooled) {
      return block(
        "provider",
        "Provider healthy",
        `Codex profile \`${profileName}\` is usage-limited until ${until} — starting now would stall. Rotate or wait.`,
      );
    }
  }

  const label = profileName ? `${provider}:${profileName}` : provider;
  return ok("provider", "Provider healthy", `Drive will launch with ${label}; not rate-limited.`);
}

/**
 * Run the drive preflight for a project, optionally auto-repairing what the one-switch
 * (`setDriveEnabled`) can fix.
 *
 * When `options.autoRepair` is set and any blocking check is auto-repairable, Drive is
 * flipped ON (ensuring the coherent pref set + stack profile + verify gate) and the
 * checks are re-evaluated so the returned report reflects the repaired state.
 */
export async function runDrivePreflight(
  projectId: string,
  database: Database,
  options: { autoRepair?: boolean; now?: string } = {},
): Promise<DrivePreflightResult> {
  const now = options.now ? new Date(options.now) : new Date();

  const evaluate = async (): Promise<{ checks: PreflightCheck[]; drive: DriveEnablementStatus }> => {
    const prefRows = await getAllPreferences(database);
    const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));
    const checks: PreflightCheck[] = [];

    // --- Project record: registered, defaultBranch set, repoPath resolvable ---
    const [project] = await getProjectRepoAndBranch(projectId, database);

    if (!project) {
      checks.push(block("project", "Project registered", "No project with this id — register it first."));
    } else {
      checks.push(ok("project", "Project registered", "Project record exists."));

      // Default branch — null makes POST /api/workspaces 400 and auto-start swallow it silently (#772/#775).
      if (project.defaultBranch && project.defaultBranch.trim()) {
        checks.push(ok("defaultBranch", "Default branch set", `defaultBranch = ${project.defaultBranch}.`));
      } else {
        checks.push(
          block(
            "defaultBranch",
            "Default branch set",
            "Project `defaultBranch` is null — workspace creation 400s and auto-start fails silently. PATCH it to the repo's branch.",
          ),
        );
      }

      // Dirty main: uncommitted tracked changes (e.g. agent-artifact .gitignore) block EVERY auto-merge.
      if (project.repoPath && project.repoPath.trim()) {
        const dirty = await getUncommittedTrackedChanges(project.repoPath);
        if (dirty.length === 0) {
          checks.push(ok("dirtyMain", "Main checkout clean", "No uncommitted tracked changes blocking merges."));
        } else {
          const preview = dirty.slice(0, 5).map((l) => l.trim()).join(", ");
          checks.push(
            block(
              "dirtyMain",
              "Main checkout clean",
              `${dirty.length} uncommitted tracked change(s) in main (${preview}${dirty.length > 5 ? ", …" : ""}) — every auto-merge is blocked until committed.`,
            ),
          );
        }
      }
    }

    // --- Status columns: an empty set 400s issue batch creation ---
    const statuses = await getProjectStatuses(projectId, database);
    if (statuses.length > 0) {
      checks.push(ok("statuses", "Status columns exist", `${statuses.length} status column(s) defined.`));
    } else {
      checks.push(
        block(
          "statuses",
          "Status columns exist",
          "No status columns — `POST /api/issues/batch` 400s with 'No statuses found'. Create the workflow columns.",
        ),
      );
    }

    // --- Stack profile: the harness needs ONE descriptor to derive its gates. Auto-repairable. ---
    const profile = await getStackProfile(projectId, database);
    if (profile) {
      checks.push(ok("stackProfile", "Stack profile present", `Detected stack: ${profile.stack ?? "unknown"}.`));
    } else {
      checks.push(
        block(
          "stackProfile",
          "Stack profile present",
          "No persisted stack profile — Drive can detect one (rule-based) on enable.",
          true,
        ),
      );
    }

    // --- Verify (merge) gate: the keystone auto-merge gate. Auto-repairable (derived from profile). ---
    const verify = prefMap.get(verifyScriptPrefKey(projectId));
    if (verify && verify.trim()) {
      checks.push(ok("verifyGate", "Verify gate set", `verify_script = ${verify}.`));
    } else {
      checks.push(
        block(
          "verifyGate",
          "Verify gate set",
          "No verify gate — approved work would merge without a build/test gate. Drive can derive one from the stack profile.",
          true,
        ),
      );
    }

    // --- Autodrive prefs coherence: the keystone opt-in + kill-switch must agree. Auto-repairable. ---
    const runtime = resolveProjectRuntimeConfig({ projectId, prefMap });

    const incoherent: string[] = [];
    if (!runtime.drive.enabled) incoherent.push("autodrive off");
    if (runtime.drive.autoMergeDisabled) incoherent.push("per-project auto-merge kill-switch armed");
    if (!runtime.drive.autoReview) incoherent.push("auto_review off");
    if (!runtime.drive.autoMerge) incoherent.push("auto_merge off");
    if (incoherent.length === 0) {
      checks.push(ok("autodrivePrefs", "Autodrive prefs coherent", "Autodrive on, kill-switch clear, review+merge on."));
    } else {
      checks.push(
        block(
          "autodrivePrefs",
          "Autodrive prefs coherent",
          `Incoherent drive prefs: ${incoherent.join("; ")}. Flip Drive on to set them coherently.`,
          true,
        ),
      );
    }

    // --- WIP target: 1 means no real parallelism (degraded, not blocking). ---
    const strategyRaw = prefMap.get(`board_strategy_${projectId}`);
    let wipTarget: number | null = null;
    if (strategyRaw) {
      try {
        wipTarget = parseStrategyBullseyeConfig(strategyRaw).activeAgentsTarget ?? null;
      } catch {
        /* malformed — leave null, falls back to legacy below */
      }
    }
    if (wipTarget === null) {
      const legacy = Number.parseInt(prefMap.get("nudge_wip_limit") ?? "", 10);
      wipTarget = Number.isFinite(legacy) ? legacy : null;
    }
    if (wipTarget !== null && wipTarget < 2) {
      checks.push(
        warn(
          "wipTarget",
          "Parallelism target",
          `WIP target is ${wipTarget} — the drive serializes one ticket at a time. Set activeAgentsTarget ≥ 2 for a real wave.`,
        ),
      );
    } else {
      checks.push(
        ok("wipTarget", "Parallelism target", `WIP target = ${wipTarget ?? "default"}.`),
      );
    }

    // --- Provider health: real profile, not credit-exhausted. ---
    checks.push(checkProviderHealth(projectId, prefMap, now));

    return { checks, drive: await getDriveStatus(projectId, database) };
  };

  let { checks, drive } = await evaluate();
  let repaired = false;

  const blockers = checks.filter((c) => c.severity === "block");
  const repairableBlockers = blockers.filter((c) => c.autoRepairable);

  // Auto-repair only when asked AND every blocker is fixable by the one-switch — flipping Drive
  // on can't conjure status columns, a default branch, a clean main, or a healthy provider, so we
  // don't claim a repair that leaves real blockers standing. Re-evaluate to reflect the new state.
  if (options.autoRepair && blockers.length > 0 && repairableBlockers.length === blockers.length) {
    await setDriveEnabled(projectId, true, database);
    ({ checks, drive } = await evaluate());
    repaired = true;
  }

  const finalBlockers = checks.filter((c) => c.severity === "block");
  return {
    projectId,
    ready: finalBlockers.length === 0,
    repairable: finalBlockers.length > 0 && finalBlockers.every((c) => c.autoRepairable),
    repaired,
    checks,
    drive,
  };
}
