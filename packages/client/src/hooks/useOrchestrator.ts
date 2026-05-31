import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api.js";

// Mirrors OrchestratorStatus in
// packages/server/src/services/orchestrator-monitor.service.ts
export interface OrchestratorStatus {
  available: boolean;
  alive: boolean;
  pid: number | null;
  lastLogAt: string | null;
  lastEventAt: string | null;
  iteration: number | null;
  phase: "running" | "idle" | "unknown";
  lastExit: number | null;
  lastDurationSec: number | null;
  recentCycles: string[];
}

const POLL_MS = 20_000;
const NOTIFY_PREF_KEY = "orchestrator_notify";

// A new cycle line worth a desktop notification (vs routine no-ops). The orchestrator
// writes one state.md line per cycle; these keywords flag the consequential ones.
const NOTEWORTHY_RE = /merg|flag|needs attention|escalat|conflict|stuck|server down|died|refill|restart|stopped/i;

function notifyEnabled(): boolean {
  try {
    return localStorage.getItem(NOTIFY_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function fireNotification(title: string, body: string) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    // Tag dedupes repeats; renotify is intentionally off to stay quiet.
    new Notification(title, { body, tag: "agentic-kanban-orchestrator" });
  } catch {
    /* notifications unsupported / blocked — ignore */
  }
}

/**
 * Poll the board-monitor orchestrator status for a project and (optionally) surface
 * desktop notifications when something noteworthy happens. Returns the latest status
 * plus the opt-in notification toggle. `status` is null until the first fetch; when
 * the repo has no orchestrator loop, `status.available` is false.
 */
export function useOrchestrator(projectId: string | null) {
  const [status, setStatus] = useState<OrchestratorStatus | null>(null);
  const [notify, setNotifyState] = useState<boolean>(notifyEnabled());

  // Transition trackers so we notify on change, not on every poll.
  const prevLastCycle = useRef<string | null>(null);
  const prevAlive = useRef<boolean | null>(null);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const setNotify = useCallback((value: boolean) => {
    setNotifyState(value);
    try {
      localStorage.setItem(NOTIFY_PREF_KEY, value ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (value && typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    if (!projectId) {
      setStatus(null);
      return;
    }
    let cancelled = false;

    async function load() {
      try {
        const data = await apiFetch<OrchestratorStatus>(`/api/projects/${projectId}/orchestrator`);
        if (cancelled) return;
        setStatus(data);
        if (!data.available) return;

        const latestCycle = data.recentCycles.length > 0 ? data.recentCycles[data.recentCycles.length - 1] : null;

        if (notifyRef.current) {
          // New noteworthy cycle line.
          if (
            latestCycle &&
            prevLastCycle.current !== null &&
            latestCycle !== prevLastCycle.current &&
            NOTEWORTHY_RE.test(latestCycle)
          ) {
            fireNotification("Board orchestrator", latestCycle.replace(/^\S+\s*\|\s*/, ""));
          }
          // Loop just died (alive true -> false).
          if (prevAlive.current === true && data.alive === false) {
            fireNotification("Board orchestrator stopped", "The board-monitor loop is no longer running.");
          }
        }

        prevLastCycle.current = latestCycle;
        prevAlive.current = data.alive;
      } catch {
        if (!cancelled) setStatus(null);
      }
    }

    void load();
    const interval = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [projectId]);

  return { status, notify, setNotify };
}
