import { useRef, useState } from "react";
import {
  RISK_POSTURES,
  RISK_POSTURE_DESCRIPTIONS,
  riskPosturePref,
  type RiskPosture as RiskPostureLevel,
} from "@agentic-kanban/shared/lib/risk-posture";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import type { RedBasePolicy } from "@agentic-kanban/shared/types";
import { useDeliveryStatus, type DeliveryController } from "../hooks/useDeliveryStatus.js";
import { useDismissable } from "../hooks/useDismissable.js";
import {
  RISK_POSTURE_LABELS,
  TRAIN_SIZE_MAX,
  TRAIN_SIZE_MIN,
  buildDeliveryChipView,
  clampStep,
  describeRedBase,
} from "../lib/deliveryChip.js";
import { setProjectPref } from "../lib/settingsStore.js";
import { showToast } from "../lib/toast.js";

const trainMaxSizePref = projectPref("train_max_size");
const trainMaxWaitMsPref = projectPref("train_max_wait_ms");
const redBasePolicyPref = projectPref("red_base_policy");
// #1238 — `off` | `daily@HH:MM`; the board cuts and drives an rc on the tick.
const promoteCadencePref = projectPref("promote_cadence");
const PROMOTE_CADENCE_SHAPE = /^(off|daily@([01]?\d|2[0-3]):[0-5]\d)$/i;

const RED_BASE_POLICY_LABELS: Record<RedBasePolicy, string> = {
  block: "Block — never merge onto a red base",
  "allow-known-debt": "Allow known debt — merge if the red set is already tracked",
  "allow-file-debt-ticket": "Allow, file a debt ticket — merge and record it",
  report: "Report only — never holds, files no ticket (for the flow posture)",
};

/**
 * The header Delivery chip (#1155/#1156) — replaces the read-only `RiskPostureChip`. Names
 * the EFFECTIVE risk posture and merge-train size from the server-resolved read model, and
 * opens a "Delivery" popover (mirroring `AutopilotChip`) that edits posture, train size/wait
 * and red-base policy in one place instead of four (Settings, a hand-written PUT, the Autopilot
 * chip's neighbourhood).
 */
export function DeliveryChip({
  activeProjectId,
  onOpenAutopilot,
}: {
  activeProjectId: string | null;
  onOpenAutopilot?: () => void;
}) {
  const delivery = useDeliveryStatus(activeProjectId);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismissable(wrapRef, open, () => setOpen(false));

  if (!activeProjectId) return null;
  const { status } = delivery;
  const view = status ? buildDeliveryChipView(status) : null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        data-testid="delivery-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={view?.title ?? "Delivery"}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-2 text-xs font-medium text-gray-600 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
      >
        {view && <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${view.dotClass}`} />}
        <span className="hidden sm:inline">{view?.label ?? "Delivery"}</span>
        <span className="sm:hidden">{view?.compactLabel ?? "Delivery"}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Delivery"
          data-testid="delivery-panel"
          className="fixed inset-x-2 bottom-2 z-50 max-h-[75vh] overflow-y-auto sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-full sm:mt-1 sm:max-h-none sm:overflow-visible sm:w-[22rem] rounded-xl border border-black/[0.07] dark:border-white/10 bg-surface-raised dark:bg-surface-raised-dark shadow-lg p-3 space-y-3 text-xs text-ink dark:text-gray-200"
        >
          {status ? (
            <DeliveryPanelBody projectId={activeProjectId} delivery={delivery} status={status} />
          ) : (
            <div className="text-ink-faint dark:text-gray-500">{delivery.error ?? "Loading delivery status…"}</div>
          )}
          {onOpenAutopilot && (
            <div className="pt-2 border-t border-black/[0.06] dark:border-white/10 flex items-center justify-between text-[11px] text-ink-soft dark:text-gray-400">
              <span>Delivery owns what lands. Autopilot owns what starts.</span>
              <button
                type="button"
                onClick={() => { setOpen(false); onOpenAutopilot(); }}
                className="text-accent-700 dark:text-accent-400 hover:underline shrink-0 ml-2"
              >
                Autopilot…
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DeliveryPanelBody({
  projectId,
  delivery,
  status,
}: {
  projectId: string;
  delivery: DeliveryController;
  status: NonNullable<DeliveryController["status"]>;
}) {
  const [saving, setSaving] = useState(false);
  const { posture } = status;

  async function save(action: () => Promise<unknown>, failure: string) {
    if (saving) return;
    setSaving(true);
    try {
      await action();
      await delivery.refresh();
    } catch (err) {
      showToast(`${failure}: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setSaving(false);
    }
  }

  const selectPosture = (level: RiskPostureLevel) =>
    save(() => setProjectPref(projectId, riskPosturePref.prefix, level), "Failed to change risk posture");

  const setTrainSize = (n: number) =>
    save(() => setProjectPref(projectId, trainMaxSizePref.prefix, String(n)), "Failed to change train size");

  const clearTrainSizeOverride = () =>
    save(() => setProjectPref(projectId, trainMaxSizePref.prefix, ""), "Failed to clear the train-size override");

  const setTrainWaitMin = (min: number) =>
    save(() => setProjectPref(projectId, trainMaxWaitMsPref.prefix, String(Math.max(0, min) * 60 * 1000)), "Failed to change train wait");

  const setRedBasePolicy = (v: RedBasePolicy) =>
    save(() => setProjectPref(projectId, redBasePolicyPref.prefix, v), "Failed to change red-base policy");

  const [cadenceDraft, setCadenceDraft] = useState<string | null>(null);
  const cadenceValue = cadenceDraft ?? (status.promoteCadence?.trim() || "off");
  const cadenceValid = PROMOTE_CADENCE_SHAPE.test(cadenceValue.trim());
  const commitCadence = () => {
    const v = cadenceValue.trim().toLowerCase();
    if (!cadenceValid || v === (status.promoteCadence?.trim().toLowerCase() || "off")) { setCadenceDraft(null); return; }
    void save(() => setProjectPref(projectId, promoteCadencePref.prefix, v === "off" ? "" : v), "Failed to change the promotion cadence").then(() => setCadenceDraft(null));
  };

  const trainWaitMin = Math.round(status.trainWindowMaxWaitMs / 60_000);

  return (
    <>
      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint dark:text-gray-500">Risk posture</div>
        <select
          value={posture.level}
          disabled={saving}
          onChange={(e) => void selectPosture(e.target.value as RiskPostureLevel)}
          data-testid="delivery-posture-select"
          className="w-full px-2 py-1.5 text-xs border border-black/[0.07] dark:border-white/10 rounded-md bg-surface-raised dark:bg-surface-raised-dark text-ink dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-accent-500 disabled:opacity-50"
        >
          {RISK_POSTURES.map((level) => (
            <option key={level} value={level}>{RISK_POSTURE_LABELS[level]}</option>
          ))}
        </select>
        <p className="mt-1 text-[11px] text-ink-soft dark:text-gray-400 leading-snug">{RISK_POSTURE_DESCRIPTIONS[posture.level]}</p>
        <p className="mt-1 text-[10px] text-ink-faint dark:text-gray-500">
          Gate: {posture.gateTier} · Review: {posture.reviewMode} · Merges/cycle: {posture.mergesPerCycle}
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium">Train size</div>
            <div className="text-[10px] text-ink-faint dark:text-gray-500 truncate">
              {status.trainWindowMaxSize <= 1
                ? "No batching — each ticket gated separately"
                : `Up to ${status.trainWindowMaxSize} tickets gated together`}
              {status.trainSizeFromOverride ? " (project override)" : ` (from ${posture.level})`}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0" data-testid="delivery-train-size">
            <button
              type="button"
              aria-label="Decrease train size"
              disabled={saving || status.trainWindowMaxSize <= TRAIN_SIZE_MIN}
              onClick={() => void setTrainSize(clampStep(status.trainWindowMaxSize - 1, TRAIN_SIZE_MIN, TRAIN_SIZE_MAX))}
              className="w-6 h-6 rounded border border-black/[0.07] dark:border-white/10 bg-surface-raised dark:bg-surface-raised-dark text-ink dark:text-gray-200 hover:bg-surface-sunken dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              −
            </button>
            <span className="w-6 text-center font-mono tabular-nums" aria-live="polite">{status.trainWindowMaxSize}</span>
            <button
              type="button"
              aria-label="Increase train size"
              disabled={saving || status.trainWindowMaxSize >= TRAIN_SIZE_MAX}
              onClick={() => void setTrainSize(clampStep(status.trainWindowMaxSize + 1, TRAIN_SIZE_MIN, TRAIN_SIZE_MAX))}
              className="w-6 h-6 rounded border border-black/[0.07] dark:border-white/10 bg-surface-raised dark:bg-surface-raised-dark text-ink dark:text-gray-200 hover:bg-surface-sunken dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              +
            </button>
          </div>
        </div>
        {status.trainSizeFromOverride && (
          <button
            type="button"
            disabled={saving}
            onClick={() => void clearTrainSizeOverride()}
            className="mt-1 text-[10px] text-accent-700 dark:text-accent-400 hover:underline disabled:opacity-50"
          >
            Follow posture ({posture.trainMaxSize}) instead
          </button>
        )}
      </div>

      <details className="group">
        <summary className="cursor-pointer select-none text-[11px] text-ink-soft dark:text-gray-400">Advanced</summary>
        <div className="mt-2 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium">Train wait</div>
              <div className="text-[10px] text-ink-faint dark:text-gray-500 truncate">Minutes before releasing a partial train</div>
            </div>
            <input
              type="number"
              min={0}
              step={1}
              value={trainWaitMin}
              disabled={saving}
              onChange={(e) => void setTrainWaitMin(Number.parseInt(e.target.value, 10) || 0)}
              data-testid="delivery-train-wait"
              className="w-16 px-2 py-1 text-xs border border-black/[0.07] dark:border-white/10 rounded bg-surface-raised dark:bg-surface-raised-dark text-ink dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-accent-500 disabled:opacity-50"
            />
          </div>
          <div>
            <div className="mb-1 font-medium">Red-base policy</div>
            <select
              value={posture.redBasePolicy}
              disabled={saving}
              onChange={(e) => void setRedBasePolicy(e.target.value as RedBasePolicy)}
              data-testid="delivery-red-base-select"
              className="w-full px-2 py-1.5 text-xs border border-black/[0.07] dark:border-white/10 rounded-md bg-surface-raised dark:bg-surface-raised-dark text-ink dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-accent-500 disabled:opacity-50"
            >
              {(Object.keys(RED_BASE_POLICY_LABELS) as RedBasePolicy[]).map((v) => (
                <option key={v} value={v}>{RED_BASE_POLICY_LABELS[v]}</option>
              ))}
            </select>
            <p className="mt-1 text-[10px] text-ink-faint dark:text-gray-500">Softer only — a stricter choice than the posture's own is ignored (#1015).</p>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium">Promotion cadence</div>
              <div className="text-[10px] text-ink-faint dark:text-gray-500 truncate">
                <code>off</code> or <code>daily@HH:MM</code> — cuts an rc from master and promotes it on green
              </div>
            </div>
            <input
              type="text"
              value={cadenceValue}
              disabled={saving}
              aria-invalid={!cadenceValid}
              onChange={(e) => setCadenceDraft(e.target.value)}
              onBlur={commitCadence}
              onKeyDown={(e) => { if (e.key === "Enter") commitCadence(); }}
              data-testid="delivery-promote-cadence"
              className={`w-28 px-2 py-1 text-xs border rounded bg-surface-raised dark:bg-surface-raised-dark text-ink dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-accent-500 disabled:opacity-50 ${cadenceValid ? "border-black/[0.07] dark:border-white/10" : "border-red-500"}`}
            />
          </div>
        </div>
      </details>

      <div className="text-[11px] text-ink-soft dark:text-gray-400">{status.baseSweep.reason}</div>
      <div className="text-[11px] text-ink-soft dark:text-gray-400" data-testid="delivery-rc">
        {status.rc
          ? `Release candidate ${status.rc.branch}: ${status.rc.state}${status.rc.tag ? ` as ${status.rc.tag}` : ""}${status.rc.state === "red" && status.rc.failedSuites.length > 0 ? ` (${status.rc.failedSuites.length} failing suite${status.rc.failedSuites.length === 1 ? "" : "s"})` : ""}`
          : "No release candidate cut yet — pnpm promote or a cadence cuts one."}
      </div>
      <div
        className={`text-[11px] ${status.redBase?.holdingWindow ? "text-red-600 dark:text-red-400" : "text-ink-soft dark:text-gray-400"}`}
        data-testid="delivery-red-base"
      >
        {describeRedBase(status.redBase)}
      </div>
    </>
  );
}
