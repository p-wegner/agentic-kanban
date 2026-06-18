import { useCallback, useEffect, useState } from "react";
import { apiFetch, apiPut } from "../lib/api.js";
import { showToast } from "./Toast.js";

interface DriveSettingsSectionProps {
  projectId: string;
  /** Notify the parent so it can refresh any settings it mirrors (auto_review/auto_merge). */
  onChanged?: () => void;
}

interface DriveStatus {
  enabled: boolean;
  details: {
    autodrive: boolean;
    autoMergeDisabled: boolean;
    autoReview: boolean;
    autoMerge: boolean;
    hasStackProfile: boolean;
    hasVerifyScript: boolean;
  };
}

/**
 * One-switch "Drive this project" toggle (#806). Flipping it sets the whole coherent bundle
 * of preferences server-side (autodrive, auto-merge kill-switch, global review+merge,
 * planMode-off, stack profile + verify gate) so the operator never has to wire them
 * individually. Off restores triage mode.
 */
export function DriveSettingsSection({ projectId, onChanged }: DriveSettingsSectionProps) {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await apiFetch<DriveStatus>(`/api/projects/${projectId}/drive`));
    } catch {
      showToast("Failed to load Drive status", "error");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(enabled: boolean) {
    setSaving(true);
    try {
      const next = await apiPut<DriveStatus>(`/api/projects/${projectId}/drive`, { enabled });
      setStatus(next);
      showToast(
        enabled ? "Driving this project — building hands-off" : "Drive off — triage mode restored",
        "success",
      );
      onChanged?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to update Drive", "error");
    } finally {
      setSaving(false);
    }
  }

  const enabled = !!status?.enabled;

  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50/50 p-3 dark:border-brand-900 dark:bg-brand-950/30">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">Drive this project</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                enabled
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200"
                  : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
              }`}
            >
              {enabled ? "DRIVING" : "TRIAGE"}
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            One switch makes this project build hands-off — auto-start, review, merge, verify
            gate, and a stack profile are all wired coherently. Turn off to return to triage
            (nothing merges without you).
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Drive this project"
          disabled={loading || saving}
          onClick={() => toggle(!enabled)}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
            enabled ? "bg-emerald-600" : "bg-gray-300 dark:bg-gray-600"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              enabled ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
      </div>

      {status && enabled && (
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
          <DriveDetail ok={status.details.autodrive} label="Auto-start" />
          <DriveDetail ok={!status.details.autoMergeDisabled} label="Auto-merge enabled" />
          <DriveDetail ok={status.details.autoReview} label="Auto-review" />
          <DriveDetail ok={status.details.autoMerge} label="Merge pipeline" />
          <DriveDetail ok={status.details.hasStackProfile} label="Stack profile" />
          <DriveDetail ok={status.details.hasVerifyScript} label="Verify gate" />
        </ul>
      )}
    </div>
  );
}

function DriveDetail({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-center gap-1">
      <span className={ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-500"}>
        {ok ? "✓" : "—"}
      </span>
      {label}
    </li>
  );
}
