import { useEffect, useState } from "react";
import { RISK_POSTURE_DESCRIPTIONS, RISK_POSTURE_LABELS, resolveRiskPosture, riskPosturePref, type RiskPosture } from "@agentic-kanban/shared/lib/risk-posture";
import { getSettings } from "../lib/settingsStore.js";

const POSTURE_DOT: Record<RiskPosture, string> = {
  strict: "bg-blue-500",
  standard: "bg-gray-400 dark:bg-gray-500",
  fast: "bg-amber-500",
  sprint: "bg-red-500",
};

/**
 * Per-project risk posture chip (#912) — the board header always names which
 * posture is active, per the proposal's honesty rule: a weaker posture may only
 * weaken verification VISIBLY, never silently. Reads the same per-project posture
 * preference the Settings -> Workflow selector writes, via `riskPosturePref` — the
 * one place the key is built (#911).
 */
export function RiskPostureChip({ activeProjectId }: { activeProjectId: string | null }) {
  const [posture, setPosture] = useState<RiskPosture | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!activeProjectId) {
      setPosture(null);
      return;
    }
    getSettings()
      .then((s) => {
        if (!cancelled) setPosture(resolveRiskPosture(s[riskPosturePref.key(activeProjectId)]));
      })
      .catch(() => {
        if (!cancelled) setPosture(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  if (!activeProjectId || !posture) return null;

  return (
    <span
      data-testid="risk-posture-chip"
      title={`Risk posture: ${RISK_POSTURE_LABELS[posture]} — ${RISK_POSTURE_DESCRIPTIONS[posture]}`}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-2 text-xs font-medium text-gray-600 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300"
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${POSTURE_DOT[posture]}`} />
      <span className="hidden sm:inline">{RISK_POSTURE_LABELS[posture]}</span>
    </span>
  );
}
