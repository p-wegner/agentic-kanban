import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";
import { db as prodDb, schema as prodSchema } from "../db.js";
import { notifyBoard as prodNotifyBoard } from "../notify.js";
import { getDiff as prodGetDiff, getDiffShortstat as prodGetDiffShortstat } from "../git-service.js";

/** Drizzle DB instance typed over the shared schema. */
export type ToolDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Dependencies injected into MCP tool handlers. Defaulting to the production
 * singletons (DB, board notifier, git) lets tools run unchanged in production
 * while unit tests pass an in-memory DB and stubbed side effects — no module
 * mocking and no spawning the MCP server over stdio.
 */
export interface ToolDeps {
  db: ToolDb;
  schema: typeof schema;
  notifyBoard: (projectId: string, reason: string) => void;
  getDiff: (workingDir: string, baseRef: string) => Promise<string>;
  getDiffShortstat: (workingDir: string, baseRef: string) => Promise<{ filesChanged: number; insertions: number; deletions: number }>;
}

/** The production dependency set wired to the real singletons. */
export const prodDeps: ToolDeps = {
  db: prodDb,
  schema: prodSchema,
  notifyBoard: prodNotifyBoard,
  getDiff: prodGetDiff,
  getDiffShortstat: prodGetDiffShortstat,
};
