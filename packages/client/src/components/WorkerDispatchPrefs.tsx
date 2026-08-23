import { useCallback, useEffect, useState } from "react";
import { apiFetch, apiPut } from "../lib/api.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * The only UI for `worker_dispatch_<projectId>` / `worker_dispatch_strict_<projectId>` /
 * `worker_labels_<projectId>` (#774, remaining #755 item 5).
 *
 * Before this, `dynamic-preference-keys.ts` declared all three and the client referenced
 * none — so opting a project into remote dispatch was a curl, while this panel's "Pair a new
 * worker" button implied the flow was complete. The placement explanation (#755) made that
 * worse in a useful way: it now names the exact preference an operator must change, and
 * there was still no control to change it.
 *
 * Scoped to ONE project (the caller passes the board's active project) rather than offering
 * a project picker: these are per-project switches on the project you are looking at, and a
 * picker here would be a second, competing place to change a project's settings.
 */
interface WorkerDispatchPrefsProps {
  projectId: string;
  projectName: string;
  /** Called after a successful write, so the fleet view can re-resolve eligibility. */
  onSaved?: () => void;
}

export function dispatchPrefKeys(projectId: string) {
  return {
    dispatch: `worker_dispatch_${projectId}`,
    strict: `worker_dispatch_strict_${projectId}`,
    labels: `worker_labels_${projectId}`,
  };
}

export function WorkerDispatchPrefs({ projectId, projectName, onSaved }: WorkerDispatchPrefsProps) {
  const keys = dispatchPrefKeys(projectId);
  const [dispatch, setDispatch] = useState(false);
  const [strict, setStrict] = useState(false);
  const [labels, setLabels] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    apiFetch<Record<string, string>>("/api/preferences/settings")
      .then((settings) => {
        setDispatch(settings[keys.dispatch] === "true");
        setStrict(settings[keys.strict] === "true");
        setLabels(settings[keys.labels] ?? "");
        setLoaded(true);
      })
      .catch((err) => {
        setError(errorMessage(err));
        setLoaded(true);
      });
  }, [keys.dispatch, keys.strict, keys.labels]);

  useEffect(load, [load]);

  const save = async (next: { dispatch?: boolean; strict?: boolean; labels?: string }) => {
    const body = {
      [keys.dispatch]: String(next.dispatch ?? dispatch),
      [keys.strict]: String(next.strict ?? strict),
      [keys.labels]: next.labels ?? labels,
    };
    setSaving(true);
    setError(null);
    try {
      // A 422 from the settings route means the key was rejected as unknown — surfaced
      // rather than swallowed, because a silently no-op'd preference write is exactly the
      // failure #874 was about.
      await apiPut("/api/preferences/settings", body);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved?.();
    } catch (err) {
      setError(errorMessage(err));
      load();
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return <div className="text-xs text-gray-400 dark:text-gray-500">Loading dispatch settings…</div>;
  }

  return (
    <div className="rounded border border-gray-200 dark:border-gray-700 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-ink dark:text-stone-100">
          Remote dispatch · {projectName}
        </div>
        {saving && <span className="text-xs text-gray-400 dark:text-gray-500">Saving…</span>}
        {saved && !saving && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
      </div>

      <label className="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-300">
        <input
          type="checkbox"
          checked={dispatch}
          disabled={saving}
          onChange={(e) => {
            setDispatch(e.target.checked);
            void save({ dispatch: e.target.checked });
          }}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">Dispatch builders to fleet workers</span>
          <span className="block text-gray-500 dark:text-gray-400">
            <code>{keys.dispatch}</code> — off means every session runs on this machine, whatever
            the fleet looks like.
          </span>
        </span>
      </label>

      <label className="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-300">
        <input
          type="checkbox"
          checked={strict}
          disabled={saving || !dispatch}
          onChange={(e) => {
            setStrict(e.target.checked);
            void save({ strict: e.target.checked });
          }}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">Strict — never fall back to this machine</span>
          <span className="block text-gray-500 dark:text-gray-400">
            <code>{keys.strict}</code> — the monitor then SKIPS a ticket with{" "}
            <code>no_available_worker</code> instead of running it locally.
          </span>
        </span>
      </label>

      <div className="text-xs text-gray-600 dark:text-gray-300">
        <div className="font-medium">Required capability labels</div>
        <div className="text-gray-500 dark:text-gray-400 mb-1">
          <code>{keys.labels}</code> — comma-separated; a worker must advertise all of them.
          Empty means any worker qualifies.
        </div>
        <input
          type="text"
          value={labels}
          disabled={saving}
          placeholder="docker,linux"
          onChange={(e) => setLabels(e.target.value)}
          onBlur={() => void save({ labels })}
          className="w-full rounded border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1 text-xs text-ink dark:text-stone-100"
        />
      </div>

      {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}
