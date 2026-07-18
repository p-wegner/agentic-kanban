// Pure, client-side derivation of a per-workspace "stall signal" (#86).
//
// A running agent that produces no output/token delta for minutes, or repeats the
// *same* tool call in a loop, looks identical to a healthy one on the board. This
// module turns the live activity/stats stream the AgentGrid already consumes into a
// single `{ state, idleSec, repeatedTool?, repeatCount? }` verdict the views badge.
//
// Time is injected (`now`) per the time-dependent-tests rule — never reads the clock
// implicitly in a way tests can't pin.

export type AgentStallState = "ok" | "stalled" | "looping";

export interface AgentStallSignal {
  state: AgentStallState;
  /** Seconds since the last observed activity/stats delta (0 when unknown). */
  idleSec: number;
  /** For `looping`: the repeated tool-call signature (tool name + args). */
  repeatedTool?: string;
  /** For `looping`: how many times in a row it repeated (>= loopWindow). */
  repeatCount?: number;
}

export interface DetectAgentStallInput {
  /** Workspace status; only `active`/`fixing` agents can stall or loop. */
  status: string | null | undefined;
  /** Epoch ms of the most recent activity/stats delta; null/undefined = unknown. */
  lastActivityAt?: number | null;
  /** Recent tool-call signatures, oldest→newest (identical string ⇒ identical call). */
  recentTools?: string[];
  /** Idle-seconds threshold for `stalled` (default 240). Non-positive ⇒ default. */
  thresholdSec?: number;
  /** Trailing identical tool calls that count as a loop (default 4). Non-positive ⇒ default. */
  loopWindow?: number;
  /** Injected clock for deterministic tests. Defaults to `Date.now()`. */
  now?: number;
}

export const DEFAULT_STALL_THRESHOLD_SEC = 240;
export const DEFAULT_LOOP_WINDOW = 4;

/** Statuses of a live, in-flight agent that can plausibly stall or loop. */
const LIVE_STATUSES = new Set(["active", "fixing"]);

/**
 * Trailing run of identical entries. Returns null unless the ring holds at least
 * `window` entries AND the last `window` of them are all the same non-empty signature.
 */
function detectLoop(
  recentTools: string[] | undefined,
  window: number,
): { tool: string; count: number } | null {
  if (!recentTools || recentTools.length < window) return null;
  const last = recentTools[recentTools.length - 1];
  if (!last) return null;
  let count = 0;
  for (let i = recentTools.length - 1; i >= 0; i--) {
    if (recentTools[i] === last) count++;
    else break;
  }
  return count >= window ? { tool: last, count } : null;
}

export function detectAgentStall(input: DetectAgentStallInput): AgentStallSignal {
  const now = input.now ?? Date.now();
  const thresholdSec =
    input.thresholdSec && input.thresholdSec > 0 ? input.thresholdSec : DEFAULT_STALL_THRESHOLD_SEC;
  const loopWindow = input.loopWindow && input.loopWindow > 0 ? input.loopWindow : DEFAULT_LOOP_WINDOW;
  const { status, lastActivityAt, recentTools } = input;

  const idleSec =
    lastActivityAt != null ? Math.max(0, Math.floor((now - lastActivityAt) / 1000)) : 0;

  // Only running/fixing agents can be stalled or looping; everything else is "ok".
  if (!status || !LIVE_STATUSES.has(status)) {
    return { state: "ok", idleSec };
  }

  // A frozen agent (no delta past the threshold) is the terminal condition — it wins
  // over a loop history that is by now stale. A genuinely-looping agent keeps emitting
  // activity, so its idleSec stays below the threshold and it falls through to the loop
  // check below.
  if (lastActivityAt != null && idleSec >= thresholdSec) {
    return { state: "stalled", idleSec };
  }

  const loop = detectLoop(recentTools, loopWindow);
  if (loop) {
    return { state: "looping", idleSec, repeatedTool: loop.tool, repeatCount: loop.count };
  }

  return { state: "ok", idleSec };
}
