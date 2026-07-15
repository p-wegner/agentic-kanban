import { createHash } from "node:crypto";
import * as lifecycleRepo from "../../repositories/session-lifecycle.repository.js";
import type { Database } from "../../db/index.js";
import type { ProviderName } from "../agent-provider.js";
import { narrowProviderName } from "../agent-provider.js";

/** Pure helpers for session launch that don't need the createSessionLifecycle closure. */

export const CODEX_SPARK_MODEL = "gpt-5.3-codex-spark";
export const CODEX_SAFE_DEFAULT_MODEL = "gpt-5.5";

export function isBuilderSession(triggerType: string | undefined, planMode: boolean | undefined): boolean {
  if (planMode) return false;
  if (!triggerType) return true;
  return triggerType === "agent" || triggerType === "auto-start" || triggerType === "plan-implement" || triggerType.startsWith("skill:");
}

/** Handoff note prefixed onto the prompt when relaunching fresh after a missing-transcript resume failure (#26). */
export function buildStaleResumeHandoffPrompt(originalPrompt: string): string {
  return (
    "[SESSION HANDOFF — resume recovery] The previous session's conversation transcript could not " +
    "be found by the provider (state likely lost — volume deleted, config dir pruned, or an image " +
    "rebuild without persisted state). Starting fresh: treat the current state of the worktree/branch " +
    "and any HANDOFF.md notes as the source of truth for what has already been done, then continue.\n\n" +
    originalPrompt
  );
}

export function instructionFingerprint(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export async function mergeExistingSessionStats(database: Database, sessionId: string, statsToSave: Record<string, unknown>): Promise<Record<string, unknown>> {
  const stats = await lifecycleRepo.getSessionStats(sessionId, database);
  if (!stats) return statsToSave;
  try {
    const existing = JSON.parse(stats) as Record<string, unknown>;
    return { ...existing, ...statsToSave };
  } catch {
    return statsToSave;
  }
}

export function lifecycleProviderName(provider: string | undefined, profile?: { provider?: string; name?: string }): ProviderName {
  // A recorded profile.provider (a valid ProviderName) wins; otherwise narrow the
  // launch provider string (handles the legacy "claude-code" id, defaults to claude).
  const fromProfile = profile?.provider;
  if (fromProfile === "codex" || fromProfile === "copilot" || fromProfile === "claude" || fromProfile === "pi") return fromProfile;
  return narrowProviderName(provider);
}
