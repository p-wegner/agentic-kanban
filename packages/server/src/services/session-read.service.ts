import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getSessionOutput, getSessionStats, getSessionSummaryData } from "../repositories/session.repository.js";

export class SessionReadError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "INVALID_DATA",
  ) {
    super(message);
  }
}

export function createSessionReadService({ database }: { database: Database }) {
  async function getOutput(sessionId: string) {
    const result = await getSessionOutput(sessionId, database);
    if (!result) throw new SessionReadError("Session not found", "NOT_FOUND");
    return result.messages;
  }

  async function getStats(sessionId: string) {
    const result = await getSessionStats(sessionId, database);
    if (result.status === "not_found") throw new SessionReadError("Session not found", "NOT_FOUND");
    if (result.status === "no_stats") throw new SessionReadError("No stats available", "NOT_FOUND");
    return result.stats;
  }

  async function getSummary(sessionId: string) {
    const result = await getSessionSummaryData(sessionId, database);
    if (!result) throw new SessionReadError("Session not found", "NOT_FOUND");
    return result;
  }

  return { getOutput, getStats, getSummary };
}

export const sessionReadService = createSessionReadService({ database: db });
