// Pure-ish launch preparation steps extracted from `startSessionInner` (#1628) so the
// session lifecycle stays under the code-health branch cap. Behavior is unchanged.
import * as lifecycleRepo from "../../repositories/session-lifecycle.repository.js";
import * as agentSkillRepo from "../../repositories/agent-skill.repository.js";
import { getProviderExitBehavior } from "../agent-provider/provider-exit-behavior.js";
import { DEFAULT_BUILDER_GUARDRAILS, PREF_BUILDER_GUARDRAILS } from "../../constants/preference-keys.js";
import type { Database } from "../../db/index.js";

/**
 * If resuming, look up the previous session's providerSessionId. Session IDs are
 * provider-local, so never pass a Claude session ID to Copilot or vice versa.
 */
export async function resolveResumeProviderSessionId(
  db: Database,
  resumeFromId: string | undefined,
  executor: string,
): Promise<string | undefined> {
  if (!resumeFromId) return undefined;
  const prev = await lifecycleRepo.getPrevSessionResumeInfo(resumeFromId, db);
  if (!prev || !prev.providerSessionId) return undefined;
  if (prev.executor !== executor) {
    console.log(`[session] skipping resume: previous executor=${prev.executor} current executor=${executor}`);
    return undefined;
  }
  const sid = prev.providerSessionId;
  // Skip mock agent session IDs (e.g. "mock-session-xxx") — they are not resumable
  if (sid.startsWith("mock-session-")) {
    console.log(`[session] skipping resume: providerSessionId=${sid} is a mock session ID`);
    return undefined;
  }
  console.log(`[session] resuming: resumeFromId=${resumeFromId} providerSessionId=${sid}`);
  return sid;
}

/** Snapshot of the skill name (the agent_skills row may be renamed or deleted later). */
export async function resolveSessionSkillName(db: Database, skillId: string | null): Promise<string | null> {
  if (!skillId) return null;
  const skillRow = await agentSkillRepo.getAgentSkillById(skillId, db);
  return skillRow?.name ?? null;
}

/** Explicit instructions win; otherwise the builder-guardrails preference or its default. */
export async function resolveEffectiveSystemInstructions(
  db: Database,
  systemInstructions: string | undefined,
  executor: string,
  builderSession: boolean,
): Promise<string | undefined> {
  const guardrailValue = await lifecycleRepo.getPreferenceValue(PREF_BUILDER_GUARDRAILS, db);
  const base = systemInstructions === undefined
    ? (guardrailValue === undefined ? DEFAULT_BUILDER_GUARDRAILS : guardrailValue)
    : systemInstructions;
  if (executor !== "codex" || !builderSession) return base;
  // Codex always augments (and never drops) the instructions, so the result is a string.
  return getProviderExitBehavior("codex").injectBuilderInstructions(base) ?? base;
}

/** For Claude only: skip-permissions is conveyed via --dangerously-skip-permissions in agentArgs. */
export function applySkipPermissionsArg(
  executor: string,
  agentArgs: string | undefined,
  skipPermissions: boolean,
): string | undefined {
  if (executor !== "claude-code") return agentArgs;
  const flag = "--dangerously-skip-permissions";
  const hasFlag = !!agentArgs?.includes(flag);
  if (skipPermissions && !hasFlag) return agentArgs ? `${agentArgs} ${flag}` : flag;
  if (!skipPermissions && hasFlag) {
    return agentArgs!.split(/\s+/).filter((a) => a && a !== flag).join(" ") || undefined;
  }
  return agentArgs;
}

/**
 * Inject HANDOFF.md context into the prompt (builder sessions without provider resume only —
 * see the #853 note at the call site). Best-effort: any failure leaves the prompt untouched.
 */
export async function injectHandoffIntoPrompt(
  prompt: string,
  workingDir: string,
  workspaceId: string,
): Promise<string> {
  try {
    const { readHandoffFile } = await import("../handoff.service.js");
    const handoff = await readHandoffFile(workingDir);
    if (!handoff) return prompt;
    console.log(`[session] HANDOFF.md injected: workspaceId=${workspaceId} size=${handoff.length}`);
    return `[SESSION HANDOFF — previous session context for this workspace. Use it to avoid re-reading files you already explored.]\n\n${handoff}\n---\n\n${prompt}`;
  } catch {
    return prompt; // handoff not available — proceed without it
  }
}
