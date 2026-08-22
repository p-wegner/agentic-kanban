/**
 * The learning step, launched from a session exit (#700 extraction).
 *
 * One responsibility: spawn the compounding-engineering "learning step" session in a workspace
 * that just finished something, on the SAME provider/profile that workspace was built with, and
 * — when the caller needs it to finish first — wait for it. Two call sites in the exit workflow
 * (`learning_step_after_review`, which waits so the merge does not race it, and
 * `learning_step_after_agent`, which does not), and nothing else in the engine touches it.
 *
 * It is cohesive because it owns the whole small protocol: resolve the launch settings, build
 * the prompt, register the session id so the exit dispatcher can recognise the learning
 * session's OWN exit, and treat every failure as non-fatal — a learning step must never be able
 * to fail a merge.
 */
import { getSessionStatus } from "../../repositories/session.repository.js";
import { buildLearningStepPrompt } from "../../services/merge-helpers.service.js";
import { resolveWorkspaceLaunchSettings, toExecutorProvider } from "../../services/agent-settings.service.js";
import type { Database } from "../../db/index.js";
import type { createSessionManager } from "../../services/session.manager.js";

/** How long a waited-on learning step may run before the exit workflow stops waiting. */
const LEARNING_STEP_WAIT_TIMEOUT_MS = 3 * 60 * 1000;
/** Poll interval for the waited-on case. */
const LEARNING_STEP_POLL_MS = 5000;

/** The subset of a workspace row the learning step needs to pick its provider/profile. */
export interface LearningStepWorkspace {
  id: string;
  provider: string | null;
  claudeProfile: string | null;
}

export interface LearningStepDeps {
  database: Database;
  sessionManager: ReturnType<typeof createSessionManager>;
  /** The engine's live set of learning-session ids, so the dispatcher recognises this session's exit. */
  learningSessionIds: Set<string>;
}

/** Resolve once the learning session leaves "running", or after the timeout — never rejects. */
async function waitForLearningSession(database: Database, learnSessId: string, label: string, timeoutMessage: string) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { console.log(timeoutMessage); resolve(); }, LEARNING_STEP_WAIT_TIMEOUT_MS);
    const poll = setInterval(() => {
      void (async () => {
        const status = await getSessionStatus(learnSessId, database);
        if (status !== null && status !== "running") {
          clearInterval(poll); clearTimeout(timeout);
          console.log(`[workflow] learning step (${label}) finished`); resolve();
        }
      })();
    }, LEARNING_STEP_POLL_MS);
  });
}

/**
 * Launch the learning step for `workspace`. `wait` makes the returned promise resolve only once
 * the learning session has left "running" (or timed out) — used by the after-review path, whose
 * synchronous foundational merge must not race it.
 */
export async function launchLearningStep(
  deps: LearningStepDeps,
  workspace: LearningStepWorkspace,
  prefMap: Map<string, string>,
  label: "after review" | "after agent",
  wait = false,
): Promise<void> {
  const { database, sessionManager, learningSessionIds } = deps;
  const workspaceId = workspace.id;
  try {
    // Run the learning step on the same provider/profile the workspace was built
    // with (e.g. its Codex OAuth license), not the global default which may have rotated.
    // #541: was an eight-line hand-rolled copy of resolveAgentSettings.
    const { agentCommand, agentArgs, provider, profile } = resolveWorkspaceLaunchSettings(prefMap, workspace);
    const prompt = buildLearningStepPrompt(false);
    const learnSessId = await sessionManager.startSession({ workspaceId, prompt, agentCommand, agentArgs, provider: toExecutorProvider(provider), triggerType: "learning", profile });
    learningSessionIds.add(learnSessId);
    console.log(`[workflow] learning step (${label}) started: session=${learnSessId}`);
    if (wait) await waitForLearningSession(database, learnSessId, label, `[workflow] learning step (${label}) timed out after 3m`);
  } catch (err) {
    console.warn(`[workflow] learning step (${label}) failed (non-fatal):`, err);
  }
}
