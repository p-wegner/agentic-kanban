/**
 * Why a worker went away (#881).
 *
 * THE COMPLAINT: every way a worker can stop being usable renders as the same word,
 * `offline`. A crashed process, a worker whose machine slept, a flaky link, and a worker
 * that is connected but too blocked to heartbeat are four different problems with four
 * different responses — wait, restart it, fix the network, look at what it is stuck on —
 * and the badge distinguishes none of them.
 *
 * WHAT THIS IS NOT: new telemetry. #774's `worker_events` timeline already records enough;
 * an operator reading it by hand can tell these apart, which is precisely why a machine
 * should. A live drop of `AO-PF38Z8R8` on 2026-08-25 showed three distinct signatures in
 * one 10-hour history, and all three were derivable from the ordering, pairing and
 * periodicity of rows already in the table. So this is a projection over what exists, not a
 * new probe: nothing has to be emitted, deployed to a worker, or kept in sync.
 *
 * THE THREE SIGNALS, and why each means what it means:
 *
 *  1. ORDERING of `disconnected` against `status_change -> offline`.
 *     A network drop closes the transport FIRST; the heartbeat deadline then trips because
 *     the socket is gone. The reverse order — offline declared while the socket is still
 *     open — means the worker was reachable and simply stopped heartbeating, which is a
 *     BLOCKED worker, not a link problem. Reading that backwards sends an operator to the
 *     network when the answer is on the worker.
 *
 *  2. PERIODICITY of the reconnect intervals.
 *     Weather is irregular. The observed drop had online->offline at exactly 60s, eighteen
 *     times unbroken, with 15-22s reconnects — variance that low is a timer firing, i.e. a
 *     mechanism (a fixed deadline, a supervisor restart), and no amount of network work
 *     changes it. High variance is the case that genuinely reads as a bad link.
 *
 *  3. PAIRING of `connected` against `disconnected`.
 *     A `connected` with no preceding close means a new socket opened while the board still
 *     believed the old one was live — a respawn or a duplicate dial (#858's shape). The
 *     observed history had 14 consecutive connects with no close between them, invisible
 *     today because nothing pairs them.
 *
 * AND THE ONE THAT DECIDES THE HEADLINE: whether the worker has RETRIED since its last
 * drop. A crash-loop reconnects — that is what makes it a loop. Zero reconnect attempts
 * after a clean heartbeat means the process exited or the machine went away, and no amount
 * of waiting fixes it. That is the difference between "it will come back" and "go look at
 * that machine", and it is the distinction an operator most needs.
 *
 * PURE by construction (a `classifyX` decision function, #585): it takes rows and a clock
 * and returns a verdict, so every case below is a table test rather than a fixture.
 */
import type { WorkerDropDiagnosis, WorkerEvent } from "@agentic-kanban/shared/types";

/**
 * The wire shape lives in shared (the `WorkerEvent` precedent, #801) because the fleet panel
 * renders it. Re-exported here because this module is where server-side callers already
 * look — one declaration, two doors.
 */
export type { WorkerDropCause, WorkerDropDiagnosis } from "@agentic-kanban/shared/types";

/**
 * A worker that has not retried for this long after a close is treated as gone rather than
 * mid-reconnect. Comfortably above the observed 15-22s backoff, so a worker in a normal
 * retry cycle is never mislabelled.
 */
const NO_RETRY_GRACE_MS = 120_000;

/**
 * How close a `status_change -> offline` must sit to a `disconnected` to be read as the
 * same episode rather than an unrelated later observation.
 */
const SAME_EPISODE_MS = 5_000;

/** Coefficient of variation below this reads as a timer rather than as weather. */
const REGULAR_CV = 0.25;

/** Fewest reconnect intervals before periodicity is claimed at all. */
const MIN_INTERVALS_FOR_PERIODICITY = 3;

type TransportKind = "connected" | "disconnected" | "offline" | "online";

interface Marker {
  kind: TransportKind;
  atMs: number;
  at: string;
}

function markerFor(event: WorkerEvent): Marker | null {
  const atMs = Date.parse(event.createdAt);
  if (!Number.isFinite(atMs)) return null;
  if (event.type === "connected") return { kind: "connected", atMs, at: event.createdAt };
  if (event.type === "disconnected") return { kind: "disconnected", atMs, at: event.createdAt };
  if (event.type === "status_change") {
    // `to` is what the transition means; a status_change with an unreadable payload is
    // dropped rather than guessed at.
    const to = event.payload?.["to"];
    if (to === "offline") return { kind: "offline", atMs, at: event.createdAt };
    if (to === "online") return { kind: "online", atMs, at: event.createdAt };
  }
  return null;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Coefficient of variation — stdev over mean, so it is scale-free. */
function coefficientOfVariation(xs: number[]): number {
  const m = mean(xs);
  if (m <= 0) return Number.POSITIVE_INFINITY;
  const variance = mean(xs.map((x) => (x - m) ** 2));
  return Math.sqrt(variance) / m;
}

function humanMs(ms: number): string {
  if (ms < 1000) return String(ms) + "ms";
  if (ms < 90_000) return String(Math.round(ms / 1000)) + "s";
  if (ms < 5_400_000) return String(Math.round(ms / 60_000)) + "m";
  return (ms / 3_600_000).toFixed(1) + "h";
}

/**
 * Derive why a worker stopped being usable, from its event timeline.
 *
 * @param events Timeline rows in EITHER order — `listWorkerEvents` returns newest-first, and
 *               sorting here means no caller has to remember which.
 * @param opts.nowMs Clock seam (epoch ms — pure arithmetic, so `nowMs` per the repo's rule).
 */
export function classifyWorkerDrop(
  events: WorkerEvent[],
  opts: { nowMs?: number } = {},
): WorkerDropDiagnosis {
  const nowMs = opts.nowMs ?? Date.now();
  const markers = events
    .map(markerFor)
    .filter((m): m is Marker => m !== null)
    .sort((a, b) => a.atMs - b.atMs);

  if (markers.length === 0) {
    return {
      cause: "insufficient-data",
      confidence: "low",
      headline: "Not enough transport history to say why this worker is unavailable.",
      detail: "No connect/disconnect rows are retained for this worker.",
      drops: 0,
      unpairedConnects: 0,
      reconnectIntervalsMs: [],
      reconnectRegular: null,
      lastDropAt: null,
      reconnectsSinceLastDrop: 0,
      msSinceLastDrop: null,
    };
  }

  const closes = markers.filter((m) => m.kind === "disconnected");
  const opens = markers.filter((m) => m.kind === "connected");

  // A `connected` is unpaired when the most recent transport marker before it is also an
  // open — the previous socket was never observed closing.
  let unpairedConnects = 0;
  let lastTransport: TransportKind | null = null;
  for (const m of markers) {
    if (m.kind !== "connected" && m.kind !== "disconnected") continue;
    if (m.kind === "connected" && lastTransport === "connected") unpairedConnects++;
    lastTransport = m.kind;
  }

  // Each close paired with the next open after it.
  const reconnectIntervalsMs: number[] = [];
  for (const close of closes) {
    const next = opens.find((o) => o.atMs > close.atMs);
    if (next) reconnectIntervalsMs.push(next.atMs - close.atMs);
  }
  const reconnectRegular =
    reconnectIntervalsMs.length >= MIN_INTERVALS_FOR_PERIODICITY
      ? coefficientOfVariation(reconnectIntervalsMs) < REGULAR_CV
      : null;

  const lastClose = closes.length > 0 ? closes[closes.length - 1]! : null;
  const reconnectsSinceLastDrop = lastClose
    ? opens.filter((o) => o.atMs > lastClose.atMs).length
    : 0;
  const msSinceLastDrop = lastClose ? Math.max(0, nowMs - lastClose.atMs) : null;

  // Ordering for the most recent episode: was the worker declared offline while its socket
  // was still open? Only an `offline` that PRECEDES the close counts — one that follows it
  // is just the deadline noticing a transport that had already gone.
  const offlineBeforeLastClose = lastClose
    ? markers.some(
        (m) =>
          m.kind === "offline" &&
          m.atMs <= lastClose.atMs &&
          lastClose.atMs - m.atMs <= SAME_EPISODE_MS,
      )
    : false;

  const base = {
    drops: closes.length,
    unpairedConnects,
    reconnectIntervalsMs,
    reconnectRegular,
    lastDropAt: lastClose?.at ?? null,
    reconnectsSinceLastDrop,
    msSinceLastDrop,
  };

  const churn =
    unpairedConnects > 0
      ? " " +
        String(unpairedConnects) +
        " socket(s) reopened with no close in between, so the worker was respawning or dialling twice."
      : "";

  // No close at all. Either genuinely healthy, or the window holds only opens — which is
  // itself the respawn signature and must not be reported as health.
  if (!lastClose) {
    if (unpairedConnects >= 2) {
      return {
        ...base,
        cause: "silent-respawn",
        confidence: "high",
        headline:
          "This worker keeps opening new connections without closing the old ones — look for a restart loop on that machine.",
        detail: String(opens.length) + " connect(s) and no close at all in the retained window." + churn,
      };
    }
    return {
      ...base,
      cause: "healthy",
      confidence: opens.length > 0 ? "high" : "low",
      headline: "No dropped connections in the retained history.",
      detail: String(opens.length) + " connect(s), no closes.",
    };
  }

  const since = humanMs(msSinceLastDrop ?? 0);

  // The decisive case: dropped and never dialled back.
  if (reconnectsSinceLastDrop === 0 && (msSinceLastDrop ?? 0) >= NO_RETRY_GRACE_MS) {
    const previously =
      reconnectIntervalsMs.length > 0
        ? " (this one previously took ~" + humanMs(Math.round(mean(reconnectIntervalsMs))) + ")"
        : "";
    return {
      ...base,
      cause: "process-gone",
      confidence: "high",
      headline:
        "The worker process is most likely gone — it dropped " +
        since +
        " ago and has made no attempt to reconnect. Restart it on that machine; waiting will not help.",
      detail:
        "A retrying worker reconnects within seconds" +
        previously +
        "; no attempts have been observed since the close at " +
        lastClose.at +
        "." +
        churn,
    };
  }

  if (offlineBeforeLastClose) {
    return {
      ...base,
      cause: "heartbeat-stall",
      confidence: "high",
      headline:
        "The worker stopped sending heartbeats while its connection was still open — it is blocked or overloaded, not unreachable.",
      detail:
        "The board declared it offline BEFORE the socket closed, which is the opposite of a network drop. Check what the worker is stuck on rather than the link." +
        churn,
    };
  }

  if (unpairedConnects >= 2) {
    return {
      ...base,
      cause: "silent-respawn",
      confidence: "high",
      headline:
        "This worker keeps reconnecting without its previous connection closing — look for a restart loop on that machine.",
      detail:
        String(closes.length) +
        " close(s) against " +
        String(opens.length) +
        " open(s) in the retained window." +
        churn,
    };
  }

  if (reconnectRegular === true) {
    return {
      ...base,
      cause: "cycling",
      confidence: "high",
      headline:
        "Drops are happening on a fixed cycle, so this is a timeout or a supervisor restarting on a timer — not a flaky network.",
      detail:
        String(closes.length) +
        " drop(s), reconnecting every ~" +
        humanMs(Math.round(mean(reconnectIntervalsMs))) +
        " with very little variation. Network work will not change a periodic signal.",
    };
  }

  if (closes.length >= 2) {
    return {
      ...base,
      cause: "flapping",
      confidence: reconnectIntervalsMs.length >= MIN_INTERVALS_FOR_PERIODICITY ? "high" : "low",
      headline:
        "The worker is dropping and reconnecting at irregular intervals — the shape of a genuinely unreliable link.",
      detail:
        String(closes.length) +
        " drop(s), reconnecting after " +
        (reconnectIntervalsMs.map(humanMs).join(", ") || "no observed reconnect") +
        "." +
        churn,
    };
  }

  return {
    ...base,
    cause: "flapping",
    confidence: "low",
    headline: "One dropped connection " + since + " ago; the worker reconnected.",
    detail: "A single drop is not yet a pattern." + churn,
  };
}
