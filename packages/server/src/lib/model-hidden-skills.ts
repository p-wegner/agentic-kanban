import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isHiddenFromModel, isSkillListing } from "@agentic-kanban/shared/lib/plugin-skill-listing";

/** Where the board writes plugin skill listings (#1251) — Claude Code's per-checkout settings file. */
export const SKILL_OVERRIDES_SETTINGS_FILE = ".claude/settings.local.json";

/**
 * The skills a checkout's settings hide from the model entirely (`user-invocable-only`/`off`) —
 * for providers with no listing mode of their own (Pi's `--skill` flags), which can only include
 * or omit a skill. Unreadable settings hide nothing.
 *
 * Its own module, read-only on purpose: `agent.service.ts` imports it, and that module's tests mock
 * `node:fs` with exactly the functions it uses — the writer's imports would break them at load.
 */
export function readModelHiddenSkills(dir: string): Set<string> {
  const hidden = new Set<string>();
  try {
    const path = join(dir, SKILL_OVERRIDES_SETTINGS_FILE);
    if (!existsSync(path)) return hidden;
    const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as { skillOverrides?: unknown };
    const overrides = parsed?.skillOverrides;
    if (!overrides || typeof overrides !== "object") return hidden;
    for (const [name, value] of Object.entries(overrides as Record<string, unknown>)) {
      if (isSkillListing(value) && isHiddenFromModel(value)) hidden.add(name);
    }
  } catch {
    /* unreadable settings hide nothing */
  }
  return hidden;
}
