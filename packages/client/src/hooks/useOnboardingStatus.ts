// #475: the persistent board-level "setup incomplete" affordance. Distinct from the wizard's own
// plan fetch — this is a lightweight status check for whichever project is currently active, so
// closing the wizard (or never opening it) doesn't erase the signal that required steps remain.
import { useCallback, useEffect, useState } from "react";
import type { OnboardingPlan } from "@agentic-kanban/shared/lib/onboarding-plan";
import { apiFetch } from "../lib/api.js";

/** How many non-optional steps are still pending — skipped/done/not-applicable don't count. */
export function pendingRequiredStepCount(plan: OnboardingPlan | null): number {
  if (!plan) return 0;
  return plan.steps.filter((s) => !s.optional && s.status === "pending").length;
}

export interface OnboardingStatus {
  pendingRequiredCount: number;
  /** True once the project's onboarding has been explicitly dismissed — the same flag the
   *  wizard's "Done — don't show again" button sets, reused here so dismissing once silences
   *  both the auto-open and the board banner. */
  dismissed: boolean;
}

const EMPTY_STATUS: OnboardingStatus = { pendingRequiredCount: 0, dismissed: true };

/** Fetches onboarding status for `projectId`; `refresh()` re-fetches on demand (e.g. after the
 *  wizard closes, since applying/skipping/dismissing a step happens inside it). */
export function useOnboardingStatus(projectId: string | null | undefined) {
  const [status, setStatus] = useState<OnboardingStatus>(EMPTY_STATUS);

  const refresh = useCallback(async (id: string | null | undefined) => {
    if (!id) { setStatus(EMPTY_STATUS); return; }
    try {
      const plan = await apiFetch<OnboardingPlan>(`/api/projects/${id}/onboarding`);
      setStatus({ pendingRequiredCount: pendingRequiredStepCount(plan), dismissed: Boolean(plan.dismissedAt) });
    } catch {
      // Non-fatal: the banner just doesn't show until the next successful refresh.
    }
  }, []);

  useEffect(() => {
    void refresh(projectId);
  }, [projectId, refresh]);

  return { ...status, refresh: useCallback(() => refresh(projectId), [refresh, projectId]) };
}
