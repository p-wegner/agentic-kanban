import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPluginPlaceholderVars,
  substitutePluginEnv,
  substitutePluginPlaceholders,
  type PluginManifest,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { Database } from "../../db/index.js";
import { insertIssueComment } from "../../repositories/issue-comments.repository.js";
import { insertPluginLoopEvent, latestPluginLoopEvent } from "../../repositories/plugin-loop-events.repository.js";
import { listPluginLoopIssues } from "../../repositories/plugins.repository.js";
import { runPluginCommand } from "../plugin-exec.js";
import type { LoopAdvanceResult } from "../plugin-loop-types.js";
import { loopAdvanceLockKey, withLoopAdvanceLock } from "./loop-advance-lock.js";
import { findLoop, keyPrefix, parseAdvancePayload, PluginLoopError } from "./loop-identity.js";

/**
 * Applying a HUMAN'S decision to a gate (#286) — the one place a person's input crosses into a
 * plugin's own command, which is what makes it a separate concern from advancing a loop:
 *
 * - The decision is validated against the loop's CURRENT gate, not the one the page was rendered
 *   with: a stale gate id is refused rather than resolved against whatever is there now.
 * - The human's free text goes through a temp FILE (`GATE_INPUT_FILE`), never shell
 *   interpolation. It is arbitrary prose and no amount of quoting makes interpolating it safe.
 * - It is serialized on the SAME per-loop lock as advances — a resolve mutates exactly the state
 *   the planner reads.
 * - The re-plan afterwards is deliberately OUTSIDE that lock (advanceLoop takes it itself) and
 *   its failure never masks a successful resolve.
 * - The decision is mirrored onto the loop TICKET's own history (#306), where a human browsing
 *   the board actually looks; the loop timeline alone is a hidden pane.
 */

export interface GateResolveResult {
  gateId: string;
  actionId: string;
  resolve: { code: number | null; stdout: string; stderr: string; timedOut: boolean };
  /** The re-plan run right after a successful resolve — the gate's replacement state. */
  advance: LoopAdvanceResult | null;
}

const GATE_RESOLVE_TIMEOUT_MS = 60 * 1000;

export interface ResolveGateArgs {
  manifest: PluginManifest;
  pluginSlug: string;
  pluginName?: string;
  pluginRowId?: string | null;
  pluginLocalPath: string;
  loopName: string;
  projectId: string;
  projectName: string;
  repoPath: string;
  leadingRepoPath: string;
  workflowTemplateId?: string | null;
  gateId: string;
  actionId: string;
  input?: string;
}

export async function resolveLoopGate(
  args: ResolveGateArgs,
  deps: {
    boardUrl: string;
    database: Database;
    /** The engine's own `advanceLoop` — it takes the per-loop lock itself, hence the re-plan
     *  happens after this function's locked section, not inside it. */
    advanceLoop: (args: ResolveGateArgs) => Promise<LoopAdvanceResult>;
  },
): Promise<GateResolveResult> {
  const { database, boardUrl } = deps;
  const loop = findLoop(args.manifest, args.loopName);
  const eventKey = { pluginSlug: args.pluginSlug, loopName: loop.name, projectId: args.projectId };

  const resolved = await withLoopAdvanceLock(
    loopAdvanceLockKey(args.projectId, args.pluginSlug, args.loopName),
    async () => {
      const gate = parseAdvancePayload(
        await latestPluginLoopEvent(eventKey, "advance", database),
      )?.gate;
      if (!gate) throw new PluginLoopError(`Loop "${loop.name}" is not blocked on a gate`, "BAD_REQUEST");
      if (gate.id !== args.gateId) {
        throw new PluginLoopError(
          `Gate "${args.gateId}" is stale — the loop's current gate is "${gate.id}". Reload and decide again.`,
          "BAD_REQUEST",
        );
      }
      const action = gate.actions.find((a) => a.id === args.actionId);
      if (!action) {
        throw new PluginLoopError(
          `Action "${args.actionId}" is not one of the gate's actions (${gate.actions.map((a) => a.id).join(", ")})`,
          "BAD_REQUEST",
        );
      }
      const text = args.input?.trim() ?? "";
      if (action.input === "text" && !text) {
        throw new PluginLoopError(`Action "${action.id}" requires a text input (e.g. revision feedback)`, "BAD_REQUEST");
      }

      const vars = buildPluginPlaceholderVars({
        outputRepoPath: args.repoPath,
        leadingRepoPath: args.leadingRepoPath,
        projectName: args.projectName,
        pluginPath: args.pluginLocalPath,
        boardUrl,
        projectId: args.projectId,
      });
      // The human's text goes through a FILE: it is arbitrary prose, and no amount of
      // quoting makes interpolating it into a shell command safe.
      const inputFile = action.input === "text"
        ? join(tmpdir(), `kanban-gate-input-${randomUUID()}.txt`)
        : null;
      if (inputFile) writeFileSync(inputFile, text, "utf8");
      try {
        const result = await runPluginCommand(substitutePluginPlaceholders(gate.resolve.command, vars), {
          cwd: gate.resolve.cwd === "repo" ? args.repoPath : args.pluginLocalPath,
          env: {
            ...substitutePluginEnv(gate.resolve.env, vars),
            GATE_ID: gate.id,
            GATE_ACTION: action.id,
            ...(inputFile ? { GATE_INPUT_FILE: inputFile } : {}),
          },
          timeoutMs: GATE_RESOLVE_TIMEOUT_MS,
        });
        if (result.timedOut || result.code !== 0) {
          throw new PluginLoopError(
            `Gate resolve command ${result.timedOut ? "timed out" : `exited ${result.code}`}: `
            + `${(result.stderr || result.stdout).slice(-800)}`,
          );
        }
        await insertPluginLoopEvent(eventKey, "gate-resolved", {
          gateId: gate.id,
          actionId: action.id,
          actionLabel: action.label,
          // An excerpt is enough for the audit trail; the full text went to the plugin.
          input: text ? text.slice(0, 500) : null,
        }, database);
        await mirrorDecisionOntoTicket({
          projectId: args.projectId,
          pluginSlug: args.pluginSlug,
          loopName: loop.name,
          gateId: gate.id,
          actionId: action.id,
          actionLabel: action.label,
          text,
          database,
        });
        return { gate, action, result };
      } finally {
        if (inputFile) {
          try { unlinkSync(inputFile); } catch { /* best effort */ }
        }
      }
    },
  );

  // Re-plan outside the lock body above (advanceLoop takes the same lock itself).
  let advance: LoopAdvanceResult | null = null;
  try {
    advance = await deps.advanceLoop({ ...args });
  } catch (err) {
    // The resolve itself succeeded — a re-plan failure must not mask that.
    console.warn(`[plugins] post-resolve advance of ${args.pluginSlug}:${loop.name} failed: ${errorMessage(err)}`);
  }
  // #357 — say something. Until now the butler produced the gate digest and the recommendation
  // BEFORE the decision and then went silent at the one moment the user is guaranteed to be
  // looking: the gate card disappears on approval and nothing replaces it. The user's report was
  // "i approved but nothing happens, the butler didnt say anything/ask".
  //
  // The sentences are pre-rendered from what the advance actually DID (`startNotices`), never
  // from `issues.statusName` — that field is measured ≥84s late (#358), so guidance built on it
  // would inherit the bug it is meant to fix. Fire-and-forget: a gate resolve must never fail or
  // block because an LLM was slow.
  //
  // #360 — `startNotices` is the union of created AND already-ticketed units, each resolved from
  // its real state. Reading `startOutcomes` here (created only) is what made the message false on
  // 2 of 3 approvals: the happy path was already right, and only this branch fell through to the
  // butler's "nothing was planned" fallback.
  void import("../plugin-gate-butler.service.js").then((m) => m.notifyButlerOfGateResolution({
    projectId: args.projectId,
    pluginName: args.pluginName ?? args.pluginSlug,
    loopLabel: loop.label ?? loop.name,
    gateId: resolved.gate.id,
    actionLabel: resolved.action.label,
    startSentences: advance?.startNotices ?? [],
    note: advance?.note ?? null,
    converged: advance?.converged ?? false,
  }, database)).catch((err) => {
    console.warn(`[plugins] gate-resolution butler turn failed for ${args.pluginSlug}:${loop.name}:`, errorMessage(err));
  });

  return {
    gateId: resolved.gate.id,
    actionId: resolved.action.id,
    resolve: {
      code: resolved.result.code,
      stdout: resolved.result.stdout.slice(-2000),
      stderr: resolved.result.stderr.slice(-2000),
      timedOut: resolved.result.timedOut,
    },
    advance,
  };
}

/**
 * #306 — mirror the decision onto the loop TICKET's own history, where a human browsing the board
 * actually looks; the loop timeline alone is a hidden pane. Best-effort: the newest ticket of this
 * loop is the unit the gate belongs to under strict-linear loops; for fan-out loops it is still
 * the round's anchor.
 */
async function mirrorDecisionOntoTicket(args: {
  projectId: string;
  pluginSlug: string;
  loopName: string;
  gateId: string;
  actionId: string;
  actionLabel: string;
  text: string;
  database: Database;
}): Promise<void> {
  try {
    const ticketRows = await listPluginLoopIssues(
      args.projectId, keyPrefix(args.pluginSlug, args.loopName), args.database,
    );
    const newest = ticketRows.sort((a, b) => (b.issueNumber ?? 0) - (a.issueNumber ?? 0))[0];
    if (newest) {
      await insertIssueComment({
        issueId: newest.id,
        workspaceId: null,
        kind: "gate-decision",
        author: "user",
        body: `Gate ${args.gateId}: ${args.actionLabel}${args.text ? ` — ${args.text.slice(0, 500)}` : ""}`,
        payload: { gateId: args.gateId, actionId: args.actionId, loop: args.loopName, pluginSlug: args.pluginSlug },
        createdAt: new Date().toISOString(),
      }, args.database);
    }
  } catch (err) {
    console.warn(`[plugins] failed to record gate decision comment:`, errorMessage(err));
  }
}
