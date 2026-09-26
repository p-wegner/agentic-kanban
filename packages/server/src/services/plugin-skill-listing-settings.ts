/**
 * Writes/removes the board's `skillOverrides` entries in `<repo>/.claude/settings.local.json`
 * (#1251) — Claude Code's own per-skill listing lever (`on | name-only | user-invocable-only |
 * off`, confirmed in 2.1.282). This file OWNS ONLY KEYS THAT ARE PLUGIN SKILL NAMES inside
 * `skillOverrides`: every other key/value in the file (and every other top-level field) is
 * preserved untouched, since `settings.local.json` is a general Claude Code config file a user
 * may already have populated with their own permissions/hooks.
 *
 * Applied at enable, removed at disable (`plugin-enablement.service.ts`), and written into each
 * newly provisioned worktree (`workspace-provision.service.ts`) — a worktree is a separate
 * checkout that never sees the leading repo's gitignored file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { SkillListing } from "@agentic-kanban/shared/lib/plugin-skill-listing";

const SETTINGS_LOCAL_RELATIVE_PATH = join(".claude", "settings.local.json");

export interface SkillListingSettingsResult {
  /** False when the write was skipped (the file is tracked by git) — see `warning`. */
  applied: boolean;
  warning: string | null;
}

function settingsLocalPath(repoPath: string): string {
  return join(repoPath, SETTINGS_LOCAL_RELATIVE_PATH);
}

/**
 * True when `.claude/settings.local.json` is tracked by git in this repo. Writing to a
 * tracked file would dirty the tree on every enable/disable/provision — the caller must skip
 * and report instead (the ticket's own scope: "skips (and reports) a settings.local.json that
 * is tracked by git, since writing it would dirty the tree").
 */
async function isTrackedByGit(repoPath: string): Promise<boolean> {
  if (!existsSync(join(repoPath, ".git"))) return false;
  const result = await gitExec(["ls-files", "--error-unmatch", "--", SETTINGS_LOCAL_RELATIVE_PATH], { cwd: repoPath });
  return execSucceeded(result);
}

function readSettingsLocal(path: string): Record<string, unknown> {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readSkillOverrides(settings: Record<string, unknown>): Record<string, string> {
  const raw = settings.skillOverrides;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function writeSettingsLocal(path: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

/**
 * Merge `{ [skillName]: mode }` into `skillOverrides`, preserving every other key this file
 * (and `skillOverrides` itself) already carries. No-ops (and does not touch the file at all)
 * when every entry is already exactly what is being written.
 */
export async function applySkillListingOverrides(
  repoPath: string,
  entries: Record<string, SkillListing>,
): Promise<SkillListingSettingsResult> {
  if (Object.keys(entries).length === 0) return { applied: true, warning: null };
  try {
    if (await isTrackedByGit(repoPath)) {
      return {
        applied: false,
        warning: `${SETTINGS_LOCAL_RELATIVE_PATH} is tracked by git in this repo — skipped writing skillOverrides ` +
          `there (writing would dirty the tree on every enable/provision). Untrack it (or add it to ` +
          `.gitignore) to let the board manage per-skill listing.`,
      };
    }
    const path = settingsLocalPath(repoPath);
    const settings = readSettingsLocal(path);
    const existing = readSkillOverrides(settings);
    const merged = { ...existing, ...entries };
    if (Object.keys(existing).length === Object.keys(merged).length
      && Object.entries(merged).every(([k, v]) => existing[k] === v)) {
      return { applied: true, warning: null };
    }
    settings.skillOverrides = merged;
    writeSettingsLocal(path, settings);
    return { applied: true, warning: null };
  } catch (err) {
    return { applied: false, warning: `failed to write ${SETTINGS_LOCAL_RELATIVE_PATH}: ${errorMessage(err)}` };
  }
}

/**
 * Remove exactly `skillNames` from `skillOverrides`, leaving every other key (and every other
 * top-level field) untouched. Used on disable — the pref-gated listing pref is gone, so the
 * override for a skill this plugin no longer contributes should go with it.
 */
export async function removeSkillListingOverrides(
  repoPath: string,
  skillNames: string[],
): Promise<SkillListingSettingsResult> {
  if (skillNames.length === 0) return { applied: true, warning: null };
  try {
    if (await isTrackedByGit(repoPath)) {
      return {
        applied: false,
        warning: `${SETTINGS_LOCAL_RELATIVE_PATH} is tracked by git in this repo — skipped removing skillOverrides there.`,
      };
    }
    const path = settingsLocalPath(repoPath);
    if (!existsSync(path)) return { applied: true, warning: null };
    const settings = readSettingsLocal(path);
    const existing = readSkillOverrides(settings);
    let changed = false;
    for (const name of skillNames) {
      if (name in existing) {
        delete existing[name];
        changed = true;
      }
    }
    if (!changed) return { applied: true, warning: null };
    if (Object.keys(existing).length === 0) {
      delete settings.skillOverrides;
    } else {
      settings.skillOverrides = existing;
    }
    writeSettingsLocal(path, settings);
    return { applied: true, warning: null };
  } catch (err) {
    return { applied: false, warning: `failed to update ${SETTINGS_LOCAL_RELATIVE_PATH}: ${errorMessage(err)}` };
  }
}
