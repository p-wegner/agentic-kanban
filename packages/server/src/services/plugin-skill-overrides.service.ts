import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { parsePluginManifest, pluginSkillName, type PluginManifest } from "@agentic-kanban/shared/lib/plugin-manifest";
import {
  PLUGIN_SKILL_LISTING_DEFAULT_KEY,
  mergePluginSkillOverrides,
  parsePluginSkillListingOverrides,
  pluginSkillListingPreferenceKey,
  resolvePluginSkillListing,
  type SkillListing,
} from "@agentic-kanban/shared/lib/plugin-skill-listing";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { Database } from "../db/index.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { listPluginRows } from "../repositories/plugins.repository.js";
import { listEnabledPlugins } from "./plugin-enabled.js";
import { SKILL_OVERRIDES_SETTINGS_FILE } from "../lib/model-hidden-skills.js";

/**
 * Board-owned listing of PLUGIN skills (#1251): writes Claude Code's `skillOverrides` into
 * `.claude/settings.local.json` next to the skills the board materialized, so an enabled plugin
 * does not load every skill description into every session. The skills' own SKILL.md files are
 * never touched — their repos stay self-contained and model-invocable on their own.
 * Resolution and merge rules: `shared/lib/plugin-skill-listing.ts`.
 */

export interface PluginSkillListingPlan {
  /** Listing per skill of every plugin ENABLED for the project. */
  desired: Record<string, SkillListing>;
  /** Every skill name of every INSTALLED plugin — the only keys the writer may touch. */
  managed: string[];
  warnings: string[];
}

export type SkillOverridesWriteStatus = "written" | "unchanged" | "skipped-tracked" | "failed";

export interface SkillOverridesWriteResult {
  status: SkillOverridesWriteStatus;
  path: string;
  message?: string;
}

function installedSkillNames(manifests: PluginManifest[]): string[] {
  const names = new Set<string>();
  for (const m of manifests) for (const s of m.skills ?? []) names.add(pluginSkillName(s.dir));
  return [...names];
}

/** Resolve the listing of every enabled plugin skill for one project. */
export async function resolveProjectPluginSkillListings(
  database: Database,
  projectId: string,
): Promise<PluginSkillListingPlan> {
  const warnings: string[] = [];
  const installed: PluginManifest[] = [];
  for (const row of await listPluginRows(database)) {
    try {
      installed.push(parsePluginManifest(row.manifestJson));
    } catch {
      // A broken cached manifest cannot name its skills; listEnabledPlugins skips it too.
    }
  }
  const globalDefault = await getPreference(PLUGIN_SKILL_LISTING_DEFAULT_KEY, database);
  const desired: Record<string, SkillListing> = {};
  for (const { row, manifest } of await listEnabledPlugins(projectId, database)) {
    const key = pluginSkillListingPreferenceKey(row.pluginId, projectId);
    const { overrides, invalid } = parsePluginSkillListingOverrides(await getPreference(key, database));
    if (invalid.length > 0) warnings.push(`${key}: ignored invalid entries ${invalid.join(", ")}`);
    for (const skill of manifest.skills ?? []) {
      const skillName = pluginSkillName(skill.dir);
      desired[skillName] = resolvePluginSkillListing({
        skillName,
        projectOverrides: overrides,
        manifestListing: skill.listing,
        globalDefault,
      });
    }
  }
  return { desired, managed: installedSkillNames(installed), warnings };
}

async function isTrackedByGit(dir: string, relPath: string): Promise<boolean> {
  const result = await gitExec(["ls-files", "--error-unmatch", "--", relPath], { cwd: dir });
  return execSucceeded(result);
}

/**
 * Keep the board-written settings file out of commits. `git rev-parse --git-path` resolves the
 * exclude file for a main checkout AND a linked worktree (whose `.git` is a file, which the
 * enable-time `addToGitInfoExclude` helper does not follow). Best-effort, like that helper.
 */
async function excludeFromGit(dir: string, relPath: string): Promise<void> {
  const result = await gitExec(["rev-parse", "--git-path", "info/exclude"], { cwd: dir });
  if (!execSucceeded(result)) return;
  const raw = result.stdout.trim();
  if (!raw) return;
  const excludePath = isAbsolute(raw) ? raw : join(dir, raw);
  try {
    mkdirSync(dirname(excludePath), { recursive: true });
    const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    if (existing.split(/\r?\n/).includes(relPath)) return;
    appendFileSync(excludePath, (existing === "" || existing.endsWith("\n") ? "" : "\n") + relPath + "\n");
  } catch {
    /* exclude bookkeeping is best-effort */
  }
}

/**
 * Merge `desired` into `<dir>/.claude/settings.local.json`'s `skillOverrides`, touching only the
 * `managed` names. A settings file TRACKED by git is left alone and reported: writing it would
 * dirty the tree (blocking auto-merge) and commit a per-machine choice into a shared file.
 */
export async function writePluginSkillOverrides(
  dir: string,
  plan: Pick<PluginSkillListingPlan, "desired" | "managed">,
): Promise<SkillOverridesWriteResult> {
  const path = join(dir, SKILL_OVERRIDES_SETTINGS_FILE);
  try {
    const exists = existsSync(path);
    if (!exists && Object.keys(plan.desired).length === 0) return { status: "unchanged", path };
    if (await isTrackedByGit(dir, SKILL_OVERRIDES_SETTINGS_FILE)) {
      return {
        status: "skipped-tracked",
        path,
        message: `${SKILL_OVERRIDES_SETTINGS_FILE} is tracked by git; plugin skill listings were not written (set skillOverrides there by hand)`,
      };
    }
    let current: Record<string, unknown> = {};
    if (exists) {
      const text = readFileSync(path, "utf8").replace(/^﻿/, "");
      const parsed: unknown = text.trim() === "" ? {} : JSON.parse(text);
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { status: "failed", path, message: `${path} is not a JSON object; left untouched` };
      }
      current = parsed as Record<string, unknown>;
    }
    const { settings, changed } = mergePluginSkillOverrides(current, plan.desired, plan.managed);
    if (!changed) return { status: "unchanged", path };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
    if (!exists) await excludeFromGit(dir, SKILL_OVERRIDES_SETTINGS_FILE);
    return { status: "written", path };
  } catch (err) {
    return { status: "failed", path, message: errorMessage(err) };
  }
}

/** Resolve for `projectId` and write into `dir` (the main checkout or one of its worktrees). */
export async function syncPluginSkillOverrides(
  database: Database,
  projectId: string,
  dir: string,
): Promise<SkillOverridesWriteResult & { warnings: string[] }> {
  const plan = await resolveProjectPluginSkillListings(database, projectId);
  const result = await writePluginSkillOverrides(dir, plan);
  return { ...result, warnings: plan.warnings };
}
