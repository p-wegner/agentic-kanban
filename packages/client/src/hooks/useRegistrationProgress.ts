import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api.js";

/**
 * Poll a registration's per-phase progress while its POST is in flight (#388).
 *
 * Registering a project showed a 30-40s spinner with nothing to read — the user could not tell
 * whether it was cloning, detecting the stack, scaffolding hooks, seeding skills or hung. On this
 * machine, where a zero-work `git --version` has measured 68ms to 51.8s (#368), "is it working or
 * wedged?" is not an idle question.
 *
 * The client mints the id so it can start polling the moment it fires the POST, rather than
 * waiting for a response it is precisely trying to get progress about.
 */
export interface RegistrationPhaseView {
  phase: string;
  label: string;
  status: "running" | "done" | "skipped" | "failed";
  startedAt: string;
  endedAt?: string;
  note?: string;
}

export interface RegistrationProgressView {
  phases: RegistrationPhaseView[];
  done: boolean;
  error?: string;
}

/** How often to ask. Fast enough that a short phase is still seen, cheap enough to ignore. */
const POLL_MS = 600;

export function useRegistrationProgress(): {
  progress: RegistrationProgressView | null;
  elapsedMs: number;
  /** Mint an id, start polling, and return the id to send with the POST. */
  begin: () => string;
  end: () => void;
} {
  const [progress, setProgress] = useState<RegistrationProgressView | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const idRef = useRef<string | null>(null);
  const timers = useRef<{ poll?: ReturnType<typeof setInterval>; tick?: ReturnType<typeof setInterval> }>({});

  const stop = useCallback(() => {
    if (timers.current.poll) clearInterval(timers.current.poll);
    if (timers.current.tick) clearInterval(timers.current.tick);
    timers.current = {};
  }, []);

  useEffect(() => stop, [stop]);

  const begin = useCallback(() => {
    stop();
    const id = crypto.randomUUID();
    idRef.current = id;
    setProgress(null);
    setElapsedMs(0);
    const startedAt = Date.now();
    timers.current.tick = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    timers.current.poll = setInterval(() => {
      void (async () => {
        try {
          const next = await apiFetch<RegistrationProgressView>(`/api/projects/registration-progress/${id}`);
          // A 404 before the first phase is normal, not an error — `apiFetch` throws and the
          // catch below simply leaves the previous state in place.
          if (idRef.current === id) setProgress(next);
        } catch {
          /* not started yet, or already swept — keep whatever we last saw */
        }
      })();
    }, POLL_MS);
    return id;
  }, [stop]);

  const end = useCallback(() => {
    idRef.current = null;
    stop();
  }, [stop]);

  return { progress, elapsedMs, begin, end };
}
