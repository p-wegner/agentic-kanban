import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../db/index.js";
import type { BuilderLeanProfile } from "./agent-provider/types.js";
import { CORE_BUILDER_SKILLS } from "./agent-provider/builder-lean-profile.js";
import { writePluginSkillOverrides, type SkillOverridesWriteResult } from "./plugin-skill-overrides.service.js";
import { SKILL_OVERRIDES_SETTINGS_FILE } from "../lib/model-hidden-skills.js";
import type { SkillListing } from "@agentic-kanban/shared/lib/plugin-skill-listing";

/**
 * Lean builder skill listing (#1312): every skill materialized in the worktree that is outside
 * `CORE_BUILDER_SKILLS` (and the project's `skills.full` add-backs) is listed `name-only`. Written
 * through the #1251 writer, so there is one `skillOverrides` writer, not two. Never `off`: with
 * skills unavailable the `Workflow` tool inlines its whole authoring guide and context grows.
 *
 * An entry already in the file (a plugin's choice, a hand-written override) is left alone, except
 * a `name-only` for a skill the project re-added in full, which is dropped so it lists in full.
 */
export async function applyBuilderSkillListing(
  dir: string,
  lean: BuilderLeanProfile | undefined,
  isDirect: boolean,
  onUnapplied?: (message: string) => void,
): Promise<void> {
  // A direct workspace is the operator's own checkout: never touched.
  if (!lean || isDirect) return;
  const res = await writeBuilderSkillListing(dir, lean.skillsFull);
  if (res.status === "failed" || res.status === "skipped-tracked") {
    const message = `lean builder skill listing was NOT applied (${res.status}${res.message ? `: ${res.message}` : ""}); non-core skill descriptions load in full this session`;
    console.warn(`[session] lean builder skill listing for ${dir}: ${res.status}${res.message ? ` (${res.message})` : ""}`);
    // #1757: the console line alone is invisible to the operator; land it on the workspace too.
    onUnapplied?.(message);
  }
}

export async function writeBuilderSkillListing(dir: string, skillsFull: string[]): Promise<SkillOverridesWriteResult> {
  const settingsPath = join(dir, SKILL_OVERRIDES_SETTINGS_FILE);
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(settingsPath)) {
      const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^﻿/, "") || "{}");
      const so = (parsed as { skillOverrides?: unknown })?.skillOverrides;
      if (so && typeof so === "object" && !Array.isArray(so)) existing = so as Record<string, unknown>;
    }
  } catch { /* the writer reports an unreadable file */ }

  let names: string[] = [];
  try {
    names = readdirSync(join(dir, ".claude", "skills")).filter((n) => !n.startsWith("."));
  } catch { /* no skills dir: nothing to list */ }

  const full = new Set(skillsFull);
  const desired: Record<string, SkillListing> = {};
  const managed: string[] = [];
  for (const name of names) {
    const keepFull = name in CORE_BUILDER_SKILLS || full.has(name);
    if (keepFull) {
      if (existing[name] === "name-only" && full.has(name)) managed.push(name);
    } else if (!(name in existing)) {
      desired[name] = "name-only";
      managed.push(name);
    }
  }
  return writePluginSkillOverrides(dir, { desired, managed });
}

/** Post the unapplied-listing outcome as a workspace diff comment (same channel as the isolation downgrade note). */
export function noteSkillListingUnapplied(db: Database, workspaceId: string, message: string): void {
  void (async () => {
    try {
      const { createDiffComment } = await import("../repositories/session.repository.js");
      await createDiffComment(workspaceId, { filePath: ".claude/settings.local.json", body: `⚠️ **Skill listing**: ${message}`, lineNumOld: null, lineNumNew: null }, db);
    } catch (err) {
      console.warn(`[session] failed to post skill-listing note: workspaceId=${workspaceId}`, err);
    }
  })();
}
