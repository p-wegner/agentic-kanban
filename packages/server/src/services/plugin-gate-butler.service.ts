import { existsSync, readFileSync } from "node:fs";
import { getBool } from "@agentic-kanban/shared/lib/settings-registry";
import type { PluginLoopCheck, PluginLoopGate } from "@agentic-kanban/shared/lib/plugin-manifest";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { getAllPreferences, getPreference } from "../repositories/preferences.repository.js";
import { getRuntimeState } from "../repositories/runtime-state.repository.js";
import { getProjectRow } from "../repositories/agent-questions.repository.js";
import { insertPluginLoopEvent } from "../repositories/plugin-loop-events.repository.js";
import { ensureButlerSession, getButlerSession, sendButlerTurn, subscribeButler } from "./butler-sdk.service.js";
import { resolveInside } from "./plugin-fs.js";

/**
 * Butler concierge for plugin gates (#307/#309/#310) — the agent-questions pattern
 * (`agent-questions/recommendation.ts`) mirrored for loop gates:
 *
 * - #307 `notifyButlerOfGate`: on every NEW gate, wake the butler (start it on demand —
 *   a gate is by definition waiting on a person, so drop-if-cold would be wrong) and
 *   inject a digest turn, so approval can happen as a conversation instead of a
 *   three-hop navigation to the gate card.
 * - #309 `computeGateRecommendation`: one short butler turn that pre-reads the gate's
 *   artifacts and stores a structured approve/revise recommendation in the loop's own
 *   event timeline (`gate-recommendation`), which `loopStatuses` surfaces as a chip.
 * - #310 `draftGateFeedback`: turn the human's rough notes into well-formed revision
 *   feedback via the same one-shot mechanism.
 *
 * Everything here is best-effort and opt-out via the `butler_gate_digest` /
 * `butler_gate_recommendation` settings. The HARD rule — the butler must never RESOLVE
 * a gate without an explicit user instruction — is enforced in the digest prompt and in
 * the MCP tool descriptions (#308), not here: this module only reads and recommends.
 */

export interface GateNotifyArgs {
  projectId: string;
  pluginRowId: string | null;
  pluginSlug: string;
  pluginName: string;
  loopName: string;
  loopLabel: string;
  gate: PluginLoopGate;
  checks: PluginLoopCheck[] | null;
  note: string | null;
  /** OUTPUT repo — where the gate's artifacts live. */
  repoPath: string;
  boardUrl: string;
}

/** Start the project's default butler if it is cold — same on-demand pattern as the
 *  agent-questions recommender, so the concierge works before the user ever opened chat. */
async function ensureWarmButler(projectId: string, database: Database): Promise<boolean> {
  if (getButlerSession(projectId).active) return true;
  const project = await getProjectRow(projectId, database);
  if (!project) return false;
  const claudeProfile = (await getPreference(`butler_profile_${projectId}`, database))
    || (await getPreference("claude_profile", database))
    || undefined;
  const model = (await getPreference(`butler_model_${projectId}`, database)) || undefined;
  const resumeSessionId = (await getRuntimeState(`butler_session_${projectId}`, database)) || undefined;
  ensureButlerSession({
    projectId,
    repoPath: project.repoPath,
    projectName: project.name,
    claudeProfile,
    model,
    resumeSessionId,
  });
  return true;
}

/** One prompt in, one final text out, over the warm butler session. */
async function oneShotButlerAsk(projectId: string, prompt: string, timeoutMs: number): Promise<{ text: string; isError: boolean }> {
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const finish = (text: string, isError: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve({ text, isError });
    };
    const unsubscribe = subscribeButler(projectId, (e) => {
      if (e.type === "text") buf += e.text;
      else if (e.type === "result") finish(e.text ?? buf, e.isError ?? false);
      else if (e.type === "error") finish(e.message, true);
    });
    const timer = setTimeout(() => finish(buf || "(timed out)", true), timeoutMs);
    sendButlerTurn(projectId, prompt);
  });
}

function describeChecks(checks: PluginLoopCheck[] | null): string {
  if (!checks || checks.length === 0) return "none reported";
  return checks.map((c) => `${c.name}: ${c.verdict.toUpperCase()}${c.detail ? ` — ${c.detail}` : ""}`).join("; ");
}

function readArtifactExcerpts(repoPath: string, gate: PluginLoopGate, maxFiles = 3, maxChars = 5000): string {
  const parts: string[] = [];
  for (const rel of (gate.artifacts ?? []).slice(0, maxFiles)) {
    try {
      const abs = resolveInside(repoPath, rel, `gate artifact "${rel}"`);
      if (!existsSync(abs)) continue;
      const raw = readFileSync(abs, "utf8");
      parts.push(`--- ${rel} (first ${Math.min(raw.length, maxChars)} chars) ---\n${raw.slice(0, maxChars)}`);
    } catch { /* unreadable artifact — recommend from the rest */ }
  }
  return parts.join("\n\n");
}

/** #307 — inject the gate digest turn. Fire-and-forget from the loop engine. */
export async function notifyButlerOfGate(args: GateNotifyArgs, database: Database = db): Promise<void> {
  try {
    const prefs = new Map((await getAllPreferences(database)).map((p) => [p.key, p.value]));
    if (!getBool(prefs, "butler_gate_digest")) return;
    if (!(await ensureWarmButler(args.projectId, database))) return;
    const artifactList = (args.gate.artifacts ?? []).map((a) => `\`${a}\``).join(", ") || "none declared";
    const actions = args.gate.actions.map((a) => `"${a.id}"${a.input === "text" ? " (requires feedback text)" : ""}`).join(", ");
    const resolveHint = args.pluginRowId
      ? `POST ${args.boardUrl}/api/plugins/${args.pluginRowId}/loops/${args.loopName}/gate/resolve with JSON `
        + `{"projectId":"${args.projectId}","gateId":"${args.gate.id}","actionId":"<action>","input":"<feedback when required>"}`
      : `the board's gate/resolve endpoint for plugin "${args.pluginSlug}", loop "${args.loopName}"`;
    // #330: ground the digest — the butler's first message should already contain
    // substance from the artifact, not just its file name. Small cap: this turn
    // fires unconditionally per gate.
    const excerpts = readArtifactExcerpts(args.repoPath, args.gate, 2, 3000);
    sendButlerTurn(
      args.projectId,
      `[gate] ${args.pluginName} — "${args.loopLabel}" reached a human approval gate.\n`
      + `Question: ${args.gate.question}\n`
      + `Verification: ${describeChecks(args.checks)}\n`
      + `Artifacts: ${artifactList}\n`
      + (excerpts ? `Artifact excerpts:\n${excerpts}\n\n` : "")
      + (args.note ? `Planner note: ${args.note}\n` : "")
      + `Available actions: ${actions}.\n\n`
      + `You may resolve this gate for the user via ${resolveHint} — but ONLY after the user explicitly `
      + `tells you their decision in this conversation; never decide for them. `
      + `Right now: tell the user what is waiting for them, name the artifacts, and give a short `
      + `substantive digest of the main artifact (read it first): 3-6 concrete findings, the `
      + `verification verdict, and any assumptions — in the language the artifact is written in. `
      + `Then offer to go deeper or discuss before they decide. If the user later asks what a step `
      + `yielded or for a summary, read the artifact and answer thoroughly (findings with specifics, `
      + `assumptions, risks, your recommendation) — never a bare list of topic headlines.`,
    );
  } catch (err) {
    console.warn(`[plugin-gate-butler] gate digest failed for ${args.pluginSlug}:${args.loopName}:`, err instanceof Error ? err.message : String(err));
  }
}

export interface GateRecommendation {
  gateId: string;
  actionId: string;
  reason: string;
}

/**
 * Why no recommendation was produced for a gate. Persisted as its own timeline event so a
 * missing chip is diagnosable after the fact.
 *
 * Every path here used to `return` silently and at most `console.warn` to a stdout nobody
 * captures. The cost was concrete: a live project reached two gates and produced ZERO
 * recommendations, and because no trace existed it was impossible to tell a disabled pref
 * from a cold butler from a malformed LLM reply — the reordering fix for #317 could not even
 * be evaluated, since "no event" looked identical before and after it.
 */
export type GateRecommendationSkipReason =
  | "disabled"
  | "no-warm-butler"
  | "ask-failed"
  | "auth-failed"
  | "reply-not-json"
  | "action-not-offered"
  | "threw";

/**
 * #355 — classify an unparseable reply before falling through to `reply-not-json`.
 *
 * The butler `ask` does NOT throw for a logged-out profile or an inaccessible model: it SUCCEEDS
 * and returns the provider's human-readable error text as the reply body. That text then fails the
 * JSON extraction, so both landed on `reply-not-json` and `ask-failed` was never used for the
 * failures it was named for. Real events measured on the live board:
 *
 *   {"gateId":"step-1:v1","reason":"reply-not-json","detail":"Not logged in · Please run /login"}
 *   {"gateId":"step-1:v1","reason":"reply-not-json","detail":"There's an issue with the selected
 *    model (Fable). It may not exist or you may not have access to it."}
 *
 * Neither is a malformed-JSON problem, and the whole point of #333's typed reasons is triage
 * without reading prose. `auth-failed` is separate from `ask-failed` because "run /login" is a
 * different human action from "pick another model".
 *
 * Matching is on provider wording, which can change — hence the fallback to `reply-not-json`
 * rather than an assertion, and hence patterns kept short and lowercased.
 */
const AUTH_ERROR_PATTERNS = [
  "not logged in",
  "please run /login",
  "invalid api key",
  "authentication_error",
  "unauthorized",
  "401",
];
const PROVIDER_ERROR_PATTERNS = [
  "issue with the selected model",
  "you may not have access to it",
  "usage limit",
  "quota",
  "rate limit",
  "overloaded",
  "insufficient_quota",
  "service unavailable",
];

export function classifyUnparseableButlerReply(text: string): "auth-failed" | "ask-failed" | "reply-not-json" {
  const haystack = text.toLowerCase();
  if (AUTH_ERROR_PATTERNS.some((p) => haystack.includes(p))) return "auth-failed";
  if (PROVIDER_ERROR_PATTERNS.some((p) => haystack.includes(p))) return "ask-failed";
  // Genuinely the model's own prose — the only case `reply-not-json` was ever meant to name.
  return "reply-not-json";
}

async function noteRecommendationSkip(
  args: GateNotifyArgs,
  reason: GateRecommendationSkipReason,
  detail: string,
  database: Database,
): Promise<void> {
  try {
    await insertPluginLoopEvent(
      { pluginSlug: args.pluginSlug, loopName: args.loopName, projectId: args.projectId },
      "gate-recommendation-skipped",
      { gateId: args.gate.id, reason, detail: detail.slice(0, 240) },
      database,
    );
  } catch {
    /* the trace is best-effort — never let it break the (already fire-and-forget) caller */
  }
}

/** #309 — compute + persist a structured recommendation for a NEW gate. Fire-and-forget. */
export async function computeGateRecommendation(args: GateNotifyArgs, database: Database = db): Promise<void> {
  try {
    const prefs = new Map((await getAllPreferences(database)).map((p) => [p.key, p.value]));
    if (!getBool(prefs, "butler_gate_recommendation")) {
      await noteRecommendationSkip(args, "disabled", "butler_gate_recommendation is off", database);
      return;
    }
    if (!(await ensureWarmButler(args.projectId, database))) {
      await noteRecommendationSkip(args, "no-warm-butler", "could not start a butler for this project", database);
      return;
    }

    const excerpts = readArtifactExcerpts(args.repoPath, args.gate);
    const actionIds = args.gate.actions.map((a) => a.id);
    const prompt =
      `A plugin pipeline gate needs a human decision; give the user a pre-read recommendation.\n`
      + `Gate: ${args.gate.question}\nVerification: ${describeChecks(args.checks)}\n`
      + (excerpts ? `Artifact excerpts:\n${excerpts}\n\n` : "")
      + `Reply with ONLY a JSON object (no prose, no code fences): `
      + `{"actionId":"<one of: ${actionIds.join(", ")}>","reason":"<under 140 chars, grounded in the verification/artifacts>"}. `
      + `Recommend the revise-style action only when you can name a concrete defect.`;
    const answer = await oneShotButlerAsk(args.projectId, prompt, 60_000);
    if (answer.isError) {
      await noteRecommendationSkip(args, "ask-failed", answer.text || "butler ask returned an error", database);
      return;
    }
    const m = answer.text.match(/\{[\s\S]*\}/);
    if (!m) {
      await noteRecommendationSkip(args, classifyUnparseableButlerReply(answer.text), answer.text, database);
      return;
    }
    // #355: a reply containing braces that are not valid JSON (prose with a `{`, or two objects so
    // the greedy match spans both) used to throw out of here and be recorded as `threw` — the
    // least actionable bucket — even though it is exactly the malformed-reply case
    // `reply-not-json` names. Classify it the same way as the no-braces case instead.
    let parsed: { actionId?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(m[0]) as { actionId?: unknown; reason?: unknown };
    } catch {
      await noteRecommendationSkip(args, classifyUnparseableButlerReply(answer.text), answer.text, database);
      return;
    }
    const actionId = typeof parsed.actionId === "string" && actionIds.includes(parsed.actionId) ? parsed.actionId : null;
    if (!actionId) {
      await noteRecommendationSkip(
        args, "action-not-offered",
        `replied ${JSON.stringify(parsed.actionId)}; gate offers ${actionIds.join(", ")}`, database,
      );
      return;
    }
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 240) : "";
    await insertPluginLoopEvent(
      { pluginSlug: args.pluginSlug, loopName: args.loopName, projectId: args.projectId },
      "gate-recommendation",
      { gateId: args.gate.id, actionId, reason } satisfies GateRecommendation,
      database,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[plugin-gate-butler] recommendation failed for ${args.pluginSlug}:${args.loopName}:`, message);
    await noteRecommendationSkip(args, "threw", message, database);
  }
}

/** #310 — expand the human's rough notes into well-formed revision feedback. Synchronous
 *  (the UI awaits it); throws on butler failure so the route can 502 honestly. */
export async function draftGateFeedback(
  args: { projectId: string; gate: PluginLoopGate; checks: PluginLoopCheck[] | null; notes: string; repoPath: string },
  database: Database = db,
): Promise<string> {
  if (!(await ensureWarmButler(args.projectId, database))) {
    throw new Error("No butler available for this project");
  }
  const excerpts = readArtifactExcerpts(args.repoPath, args.gate, 2, 3000);
  const prompt =
    `The user wants to send REVISION FEEDBACK for a gated pipeline artifact but has only rough notes. `
    + `Write the feedback they should submit: specific, actionable, referencing the artifact where useful, `
    + `in the artifact's own language, under 200 words. Reply with ONLY the feedback text (no preamble).\n\n`
    + `Gate: ${args.gate.question}\nVerification: ${describeChecks(args.checks)}\n`
    + (excerpts ? `Artifact excerpts:\n${excerpts}\n\n` : "")
    + `User's rough notes:\n${args.notes}`;
  const answer = await oneShotButlerAsk(args.projectId, prompt, 60_000);
  if (answer.isError) throw new Error(`Butler draft failed: ${answer.text.slice(0, 200)}`);
  return answer.text.trim();
}

/** #330 — one-click decision-ready digest of the CURRENT gate's artifacts. Synchronous
 *  (the UI awaits it and renders the summary on the gate card); throws so the route
 *  can 502 honestly. */
export async function summarizeGateArtifacts(
  args: { projectId: string; gate: PluginLoopGate; checks: PluginLoopCheck[] | null; repoPath: string },
  database: Database = db,
): Promise<string> {
  if (!(await ensureWarmButler(args.projectId, database))) {
    throw new Error("No butler available for this project");
  }
  const excerpts = readArtifactExcerpts(args.repoPath, args.gate, 3, 6000);
  const prompt =
    `The user must decide an approval gate and wants a decision-ready summary of the artifact under review. `
    + `Write it in the artifact's own language. Include: the key findings as CONCRETE statements (names, `
    + `numbers — not topic headlines), the verification verdict and what was fixed, every assumption, open `
    + `risks or gaps worth weighing, and one closing recommendation line. Aim for 10-20 substantive lines. `
    + `Reply with ONLY the summary (no preamble).\n\n`
    + `Gate: ${args.gate.question}\nVerification: ${describeChecks(args.checks)}\n`
    + (excerpts ? `Artifact excerpts:\n${excerpts}\n` : "");
  const answer = await oneShotButlerAsk(args.projectId, prompt, 90_000);
  if (answer.isError) throw new Error(`Butler summary failed: ${answer.text.slice(0, 200)}`);
  return answer.text.trim();
}

/**
 * #357/#354 — the butler's post-resolution turn.
 *
 * The moment after a decision is the ONE moment the user is guaranteed to be looking, and it was
 * the only part of the exchange where the butler said nothing: the gate card vanishes on approval
 * and nothing replaces it. From the user's seat "a ticket was planned and will start", "nothing
 * will ever start" and "something failed" are indistinguishable — and the user's own report was
 * "i approved but nothing happens, the butler didnt say anything/ask".
 *
 * Two rules make this reporting trustworthy rather than another over-claim:
 *
 * 1. **Every state claim comes from what the board DID, not from a pipeline-level word.** The turn
 *    is built from the advance's `startOutcomes` (see plugin-loop-start.service.ts), which record
 *    the actual decision per ticket. The previous failure here was the mirror image of silence: the
 *    butler asserted "State: generating" for a ticket parked in Backlog with no workspace (#354),
 *    because it paraphrased the planner's note as an execution state it had never read.
 * 2. **It does NOT read `issues.statusName`.** That field is demonstrably late — measured at ≥84s
 *    behind the workspace row (#358) — so guidance derived from it would inherit the very bug it is
 *    meant to fix. Workspace-derived truth only.
 *
 * The prompt CARRIES the sentences rather than asking the butler to compose them from raw state:
 * an LLM handed a state blob is exactly what produced the "generating" over-claim.
 */
export interface GateResolutionNotifyArgs {
  projectId: string;
  pluginName: string;
  loopLabel: string;
  gateId: string;
  actionLabel: string;
  /** Pre-rendered, falsifiable sentences — one per ticket the advance planned. */
  startSentences: string[];
  /** The planner's note for the new state, if any. Presented AS a plan, never as execution state. */
  note: string | null;
  converged: boolean;
}

export async function notifyButlerOfGateResolution(args: GateResolutionNotifyArgs, database: Database = db): Promise<void> {
  try {
    const prefs = new Map((await getAllPreferences(database)).map((p) => [p.key, p.value]));
    // Same opt-out as the digest turn: a user who silenced the gate concierge does not want a
    // resolution turn either.
    if (!getBool(prefs, "butler_gate_digest")) return;
    if (!(await ensureWarmButler(args.projectId, database))) return;

    const outcomeBlock = args.startSentences.length > 0
      ? "What the board did next (these are FACTS from the board — report them as-is):\n"
        + args.startSentences.map((line) => `- ${line}`).join("\n") + "\n"
      : args.converged
        ? "The loop is now CONVERGED — no further units were planned. There is nothing left to start.\n"
        // #360: this branch used to assert "the loop is waiting on something else, not on you" — a
        // cause the board had NOT checked, and which was false on 2 of 3 live approvals (the next
        // step's ticket already existed and was 80s from a live workspace). With `startNotices` now
        // covering already-ticketed units too, reaching this branch means the re-plan produced
        // nothing at all, usually because it FAILED. Say that, and say nothing about why.
        : "The re-plan after this decision reported no units, and the board could not determine what "
          + "happens next. Do NOT tell the user a ticket was or was not planned — say the decision is "
          + "recorded, that the next step is not visible yet, and that reloading the loop panel (or "
          + "\"Advance now\") will show it.\n";

    sendButlerTurn(
      args.projectId,
      `[gate-resolved] ${args.pluginName} — "${args.loopLabel}": gate ${args.gateId} was resolved as `
      + `"${args.actionLabel}" by the user.\n`
      + outcomeBlock
      + (args.note ? `Planner note about the NEW state (this is a PLAN, not something that is running): ${args.note}\n` : "")
      + "\nTell the user, in two or three sentences: that their decision was recorded, and exactly what "
      + "happens next using the facts above.\n"
      + "HARD RULES for this turn:\n"
      + "- Do NOT claim any ticket is \"generating\", \"running\", \"in progress\" or \"working\" — you have not "
      + "observed that. The facts above are the ONLY execution claims you may make.\n"
      + "- If a fact above says a ticket will not start on its own, OFFER to start it and say how.\n"
      + "- Do not re-summarise the artifacts you already digested; the user just decided on them.",
    );
  } catch (err) {
    console.warn(`[plugin-gate-butler] gate-resolution turn failed for ${args.pluginName}:`, err instanceof Error ? err.message : String(err));
  }
}
