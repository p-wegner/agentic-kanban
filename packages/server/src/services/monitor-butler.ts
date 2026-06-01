/**
 * Monitor Butler — an autonomous, cron-driven board-health agent.
 *
 * Distinct from the *User Butler* (`butler-sdk.service.ts`), which is a warm,
 * interactive, one-session-per-project assistant the user chats with. The Monitor
 * Butler instead spawns a FRESH Claude Agent SDK session on a fixed schedule
 * (default every 15 min), injects the current board state plus a natural-language
 * strategy, lets it act through the `agentic-kanban` MCP tools, captures its output,
 * and logs every step to the `board_health_events` audit table — then tears the
 * session down. Nothing about it blocks user interactions: it owns no shared
 * session map and each cycle is independent and short-lived.
 *
 * Why a fresh session per cycle (not warm like the User Butler): board health is a
 * stateless "look at the board now, act, done" task. A cold session each cycle keeps
 * context small, avoids drift across hours of accumulated history, and means a
 * crashed/hung cycle never poisons the next one.
 *
 * Strategy resolution: reads the project's SINGLE monitor-policy source of truth —
 * `scripts/board-monitor/objective.md`, shared with the codex board-monitor loop —
 * if present; otherwise falls back to a built-in default (merge clean work, restart
 * stale agents, pull ready tickets). The objective is authored for the codex loop,
 * but its priorities and TUNABLE TARGETS block are mechanism-agnostic; this butler
 * interprets the shared intent and ignores loop-harness specifics (e.g. the
 * `state.md` memory line). Keeping ONE policy file means the two monitor mechanisms
 * can never drift into conflicting strategies.
 *
 * Gating: the `monitor_butler_enabled` preference must be "true"; cadence comes from
 * `monitor_butler_interval_min` (default 15). A 30s sync loop picks up preference
 * changes without a server restart, mirroring the existing board-monitor pattern.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { projects, preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { logBoardHealthEvent } from "../repositories/board-health-events.repository.js";
import { buildSpawnEnv, getMcpServersConfig } from "./agent-provider/helpers.js";
import { getBoardStatus } from "./board-status.js";
import { isTransientNetworkError } from "../startup/transient-errors.js";

// Single source of truth for monitor policy, shared with the codex board-monitor
// loop (scripts/board-monitor/loop.sh). Edit that one file to steer both.
const STRATEGY_FILE = "scripts/board-monitor/objective.md";
const DEFAULT_INTERVAL_MIN = 15;
/** Hard ceiling on a single cycle so a stuck session can never run past the next tick. */
const CYCLE_TIMEOUT_MS = 10 * 60 * 1000;

/** Built-in strategy used when the project has no monitor objective file. */
export const DEFAULT_MONITOR_STRATEGY = [
  "You are the autonomous Monitor Butler for this kanban board. No human is watching this turn — act, don't ask.",
  "Default strategy (apply unless the board state clearly argues against a specific action):",
  "1. Merge clean work: for any workspace that is idle, ready for merge, and has no conflicts, merge it via the merge_workspace MCP tool.",
  "2. Restart stale agents: if an in-progress workspace has a session that has clearly stalled (no recent activity, not awaiting plan approval), relaunch it via relaunch_workspace.",
  "3. Pull ready tickets: if board capacity allows and there are Todo/Backlog tickets with no blocking dependencies, that's a candidate to start — but only observe and note it; do not auto-start work unless the strategy explicitly says to.",
  "Be conservative: never take a destructive or irreversible action you are unsure about. When in doubt, observe and log rather than act.",
  "Verify before claiming success — re-check with get_board_status / get_issue after any merge or relaunch.",
].join("\n");

interface MonitorButlerState {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  currentIntervalMin: number | null;
  lastRunAt: string | null;
  lastCycleId: string | null;
}

const state: MonitorButlerState = {
  timer: null,
  running: false,
  currentIntervalMin: null,
  lastRunAt: null,
  lastCycleId: null,
};

/** Read the project's strategy file, or fall back to the built-in default. */
function resolveStrategy(repoPath: string): { text: string; source: "file" | "default" } {
  try {
    const path = join(repoPath, STRATEGY_FILE);
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8").trim();
      if (text) return { text, source: "file" };
    }
  } catch {
    /* fall through to default */
  }
  return { text: DEFAULT_MONITOR_STRATEGY, source: "default" };
}

function buildMonitorSystemPrompt(projectName: string, repoPath: string): string {
  const serverPort = process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001";
  return [
    `You are the autonomous Monitor Butler for the project "${projectName}" — a background board-health agent in the agentic-kanban board.`,
    `Project location: ${repoPath}`,
    `Board API: http://localhost:${serverPort}/api`,
    `You run on a schedule with NO human in the loop. Use the "agentic-kanban" MCP tools (get_board_status, list_issues, get_issue, merge_workspace, relaunch_workspace, etc.) to read board state and act on it. Do NOT guess board state or scrape it via curl.`,
    `Never claim an action succeeded (merged, relaunched, started) unless the board confirms it — re-check with get_board_status / get_issue and report the real result.`,
    `Do NOT edit source code or run git directly. Your job is orchestration through the board's tools, not implementation.`,
    `End your turn with a short summary of what you observed and what you did (or chose not to do, and why).`,
  ].join("\n");
}

/**
 * Run a single monitor cycle: snapshot the board, spawn a fresh Agent SDK session,
 * feed it the strategy, capture its output, and log everything to board_health_events.
 * Best-effort and fully self-contained — never throws to the caller.
 */
export async function runMonitorButlerCycle(opts?: { projectId?: string }): Promise<void> {
  if (state.running) {
    console.log("[monitor-butler] cycle already running — skipping this tick");
    return;
  }
  state.running = true;
  const cycleId = randomUUID();
  state.lastCycleId = cycleId;
  state.lastRunAt = new Date().toISOString();

  let projectId = opts?.projectId;
  try {
    if (!projectId) {
      projectId = (await getPreference("activeProjectId")) ?? undefined;
    }
    if (!projectId) {
      console.log("[monitor-butler] no active project — skipping cycle");
      return;
    }

    const projectRows = await db
      .select({ id: projects.id, name: projects.name, repoPath: projects.repoPath })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (projectRows.length === 0) {
      console.warn(`[monitor-butler] project ${projectId} not found — skipping cycle`);
      return;
    }
    const project = projectRows[0];

    const { text: strategy, source } = resolveStrategy(project.repoPath);
    const board = await getBoardStatus({ projectId });

    await logBoardHealthEvent({
      projectId,
      cycleId,
      eventType: "cycle_start",
      summary: `Monitor cycle started (strategy: ${source}, ${board.totals.totalIssues} open issues, ${board.totals.activeWorkspaces} active workspaces)`,
      details: { strategySource: source, totals: board.totals },
    });

    const claudeProfile = (await getPreference("claude_profile")) ?? undefined;
    const result = await runAgentTurn({
      projectId,
      cycleId,
      repoPath: project.repoPath,
      projectName: project.name,
      claudeProfile: claudeProfile || undefined,
      prompt: buildCyclePrompt(strategy, board),
    });

    await logBoardHealthEvent({
      projectId,
      cycleId,
      eventType: result.isError ? "error" : "cycle_end",
      summary: result.isError
        ? `Monitor cycle ended with error: ${result.text.slice(0, 200)}`
        : `Monitor cycle complete: ${(result.text || "(no summary)").slice(0, 300)}`,
      details: { toolsUsed: result.toolsUsed, isError: result.isError },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[monitor-butler] cycle error: ${message}`);
    if (projectId) {
      await logBoardHealthEvent({ projectId, cycleId, eventType: "error", summary: `Monitor cycle failed: ${message}` }).catch(() => {});
    }
  } finally {
    state.running = false;
  }
}

function buildCyclePrompt(strategy: string, board: Awaited<ReturnType<typeof getBoardStatus>>): string {
  return [
    "It is time for a board-health monitor cycle. Apply the strategy below to the current board.",
    "",
    "## Strategy",
    strategy,
    "",
    "## Current board snapshot (authoritative source; re-query MCP tools for live detail before acting)",
    "```json",
    JSON.stringify(board, null, 2),
    "```",
    "",
    "Act now according to the strategy, then give a concise summary of what you observed and did.",
  ].join("\n");
}

interface AgentTurnResult {
  text: string;
  isError: boolean;
  toolsUsed: string[];
}

/**
 * Spawn a fresh Agent SDK session, run exactly one turn, and resolve with the final
 * result text + the tool names it invoked. The session is torn down via abort once the
 * result message arrives (or on timeout). Per-tool actions are logged as "action" events.
 */
async function runAgentTurn(opts: {
  projectId: string;
  cycleId: string;
  repoPath: string;
  projectName: string;
  claudeProfile?: string;
  prompt: string;
}): Promise<AgentTurnResult> {
  const abort = new AbortController();
  const toolsUsed: string[] = [];
  const env = buildSpawnEnv(opts.claudeProfile);
  const options: Options = {
    cwd: opts.repoPath,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    env: env as Options["env"],
    abortController: abort,
    systemPrompt: { type: "preset", preset: "claude_code", append: buildMonitorSystemPrompt(opts.projectName, opts.repoPath) },
    mcpServers: getMcpServersConfig(),
  };

  const timeout = setTimeout(() => abort.abort(), CYCLE_TIMEOUT_MS);
  try {
    console.log(`[monitor-butler] starting cycle session: project=${opts.projectId} cycle=${opts.cycleId}`);
    const q = query({ prompt: opts.prompt, options });
    for await (const msg of q as AsyncIterable<Record<string, unknown>>) {
      const type = msg.type as string;
      if (type === "assistant") {
        const content = (msg as { message?: { content?: Array<{ type?: string; name?: string }> } }).message?.content ?? [];
        for (const block of content) {
          if (block.type === "tool_use" && block.name) {
            toolsUsed.push(block.name);
            // Log each board-affecting tool call as an auditable action.
            void logBoardHealthEvent({
              projectId: opts.projectId,
              cycleId: opts.cycleId,
              eventType: "action",
              summary: `Invoked tool: ${block.name}`,
              details: { tool: block.name },
            }).catch(() => {});
          }
        }
      } else if (type === "result") {
        const subtype = (msg as { subtype?: string }).subtype;
        const result = (msg as { result?: string }).result;
        return { text: result ?? "", isError: subtype !== "success", toolsUsed };
      }
    }
    return { text: "", isError: false, toolsUsed };
  } catch (err) {
    if (abort.signal.aborted) {
      return { text: "Monitor cycle aborted (timeout or shutdown)", isError: true, toolsUsed };
    }
    if (isTransientNetworkError(err)) {
      console.warn(`[monitor-butler] transient network error (ignored): ${err instanceof Error ? err.message : err}`);
      return { text: "Transient network error", isError: true, toolsUsed };
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
}

/**
 * Start the Monitor Butler scheduler. Polls the `monitor_butler_enabled` /
 * `monitor_butler_interval_min` preferences every 30s and (re)schedules cycles
 * accordingly, so toggling it in Settings takes effect without a server restart.
 * Mirrors the board-monitor sync pattern (`monitor-setup.ts`).
 */
export function startMonitorButler(): void {
  async function scheduleNext() {
    const enabled = (await getPreference("monitor_butler_enabled").catch(() => null)) === "true";
    if (!enabled) {
      if (state.timer) {
        console.log("[monitor-butler] disabled — stopping scheduler");
        clearTimeout(state.timer);
        state.timer = null;
        state.currentIntervalMin = null;
      }
      return;
    }
    const raw = await getPreference("monitor_butler_interval_min").catch(() => null);
    const intervalMin = (() => {
      const n = parseInt(raw || "", 10);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MIN;
    })();

    // Already scheduled at the right interval — nothing to do.
    if (state.timer && intervalMin === state.currentIntervalMin) return;

    if (state.timer) clearTimeout(state.timer);
    state.currentIntervalMin = intervalMin;
    console.log(`[monitor-butler] enabled — scheduling cycles every ${intervalMin}m`);
    const tick = () => {
      runMonitorButlerCycle()
        .catch((err) => console.error("[monitor-butler] unhandled cycle error:", err))
        .finally(() => {
          if (state.currentIntervalMin) {
            state.timer = setTimeout(tick, state.currentIntervalMin * 60 * 1000);
          }
        });
    };
    // Run the first cycle shortly after enabling, then on the interval.
    state.timer = setTimeout(tick, 5_000);
  }

  setInterval(() => { scheduleNext().catch(() => {}); }, 30_000);
  scheduleNext().catch(() => {});
}
