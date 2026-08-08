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

/** #309 — compute + persist a structured recommendation for a NEW gate. Fire-and-forget. */
export async function computeGateRecommendation(args: GateNotifyArgs, database: Database = db): Promise<void> {
  try {
    const prefs = new Map((await getAllPreferences(database)).map((p) => [p.key, p.value]));
    if (!getBool(prefs, "butler_gate_recommendation")) return;
    if (!(await ensureWarmButler(args.projectId, database))) return;

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
    if (answer.isError) return;
    const m = answer.text.match(/\{[\s\S]*\}/);
    if (!m) return;
    const parsed = JSON.parse(m[0]) as { actionId?: unknown; reason?: unknown };
    const actionId = typeof parsed.actionId === "string" && actionIds.includes(parsed.actionId) ? parsed.actionId : null;
    if (!actionId) return;
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 240) : "";
    await insertPluginLoopEvent(
      { pluginSlug: args.pluginSlug, loopName: args.loopName, projectId: args.projectId },
      "gate-recommendation",
      { gateId: args.gate.id, actionId, reason } satisfies GateRecommendation,
      database,
    );
  } catch (err) {
    console.warn(`[plugin-gate-butler] recommendation failed for ${args.pluginSlug}:${args.loopName}:`, err instanceof Error ? err.message : String(err));
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
