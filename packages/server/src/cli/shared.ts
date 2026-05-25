import { db } from "../db/index.js";
import { preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { applyMigrations } from "../db/manual-migrate.js";

export const DEFAULT_STATUSES = [
  { name: "Todo", sortOrder: 0, isDefault: true },
  { name: "In Progress", sortOrder: 1, isDefault: false },
  { name: "In Review", sortOrder: 2, isDefault: false },
  { name: "AI Reviewed", sortOrder: 3, isDefault: false },
  { name: "Done", sortOrder: 4, isDefault: false },
  { name: "Cancelled", sortOrder: 5, isDefault: false },
];

export function logDefaultBranch(defaultBranch: string | null | undefined, indent = "  ") {
  if (defaultBranch) {
    console.log(`${indent}Branch: ${defaultBranch}`);
    return;
  }
  console.warn(`${indent}Warning: no default branch detected (looked for local main, then master).`);
  console.warn(`${indent}Set it manually in project settings before creating worktrees.`);
}

export async function runMigrations() {
  const { rawClient } = await import("../db/index.js");
  await applyMigrations(rawClient);
}

export async function getActiveProjectId(): Promise<string> {
  const pref = await db.select().from(preferences).where(eq(preferences.key, "activeProjectId")).limit(1);
  if (pref.length === 0) throw new Error("No active project. Run `pnpm cli -- register <path>` first.");
  return pref[0].value;
}

export function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
