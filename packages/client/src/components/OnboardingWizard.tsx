import { useCallback, useEffect, useState } from "react";
// Deep path, not the root barrel: #463 exports the plan model as its own entry point. The module
// is pure strings + data (no Node builtins), so it is safe in the client bundle.
import type { OnboardingPlan, OnboardingStep } from "@agentic-kanban/shared/lib/onboarding-plan";
import { apiFetch, apiPost } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { useOnboardingStore } from "../stores/onboardingStore.js";

/**
 * Onboarding wizard (#464) — takes a freshly imported project from "it shows on the board" to
 * "the board can actually drive it".
 *
 * Registration stops at `scaffoldAndPopulateProject`: stack profile, setup/verify scripts, hooks,
 * starter docs. Everything after that (Start Mode — which defaults to `manual`, so NOTHING
 * auto-starts — WIP, plugins, project-scoped init skills, a non-empty backlog) was left for the
 * user to find in Settings or never happened at all. This renders the plan from #463 as a
 * checklist and applies one step at a time.
 *
 * Two rules it inherits from the plan model and must not break:
 *  - **Status is derived server-side.** Every apply/skip returns the recomputed plan and we render
 *    THAT, rather than optimistically flipping a local flag. A local copy would drift from the
 *    board's own view of the world, which is the bug the derived-status design exists to prevent.
 *  - **Nothing here runs an agent.** `init-skill` and `ticket` steps file a ticket; the user can
 *    see, edit or delete it, and it goes through the normal workspace/review/merge flow.
 */

const SECTIONS: { kind: OnboardingStep["kind"]; title: string; blurb: string }[] = [
  { kind: "config", title: "Detected setup", blurb: "How the board provisions, verifies and drives this project." },
  { kind: "plugin", title: "Plugins", blurb: "Optional. Enabling one materializes its skills into the repo." },
  { kind: "init-skill", title: "Init skills", blurb: "One-time passes over a fresh codebase. Each files a ticket — nothing runs now." },
  { kind: "ticket", title: "Suggested first tickets", blurb: "A starter backlog, so the board has something to pick up." },
];

const START_MODES = [
  { value: "manual", label: "Manual — nothing auto-starts" },
  { value: "monitor", label: "Monitor — the board starts backlog tickets up to the WIP limit" },
  { value: "conductor", label: "Conductor — an out-of-process loop drives this project" },
];

type StepStatus = OnboardingStep["status"];

function StatusChip({ status }: { status: StepStatus }) {
  const tones: Record<StepStatus, string> = {
    "done": "border-green-300 dark:border-green-800 text-green-800 dark:text-green-300 bg-green-50 dark:bg-green-900/20",
    "pending": "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 bg-transparent",
    "skipped": "border-gray-200 border-dashed dark:border-gray-700 text-gray-400 dark:text-gray-500 bg-gray-50/60 dark:bg-gray-800/30",
    "not-applicable": "border-gray-200 border-dashed dark:border-gray-700 text-gray-400 dark:text-gray-500 bg-transparent",
  };
  const tone = tones[status];
  const label: Record<StepStatus, string> = { "done": "✓ done", "pending": "○ to do", "skipped": "skipped", "not-applicable": "n/a" };
  return <span className={`shrink-0 rounded border px-1.5 text-[10px] ${tone}`} data-testid={`onboarding-status-${status}`}>{label[status]}</span>;
}

export function OnboardingWizard() {
  const projectId = useOnboardingStore((s) => s.projectId);
  const projectName = useOnboardingStore((s) => s.projectName);
  const justImported = useOnboardingStore((s) => s.justImported);
  const closeOnboarding = useOnboardingStore((s) => s.closeOnboarding);

  const [plan, setPlan] = useState<OnboardingPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyStepId, setBusyStepId] = useState<string | null>(null);
  // Per-step draft values for the config steps that take one. Keyed by step id.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      setPlan(await apiFetch<OnboardingPlan>(`/api/projects/${id}/onboarding`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!projectId) { setPlan(null); setDrafts({}); return; }
    void load(projectId);
  }, [projectId, load]);

  if (!projectId) return null;

  async function act(path: string, body: Record<string, unknown>, stepId: string) {
    setBusyStepId(stepId);
    setError(null);
    try {
      // Render what the SERVER recomputed — never a locally flipped status.
      setPlan(await apiPost<OnboardingPlan>(`/api/projects/${projectId}/onboarding/${path}`, body));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      showToast(message, "error");
    } finally {
      setBusyStepId(null);
    }
  }

  async function dismiss() {
    try {
      await apiPost(`/api/projects/${projectId}/onboarding/dismiss`, {});
    } catch {
      // Dismissal is a convenience; failing to record it must not trap the user in the modal.
    }
    closeOnboarding();
  }

  /** The input a config step needs before it can be applied, if any. */
  function configInput(step: OnboardingStep): Record<string, unknown> | null | "external" {
    if (step.kind !== "config") return {};
    switch (step.configKey) {
      case "stack-profile":
        return {}; // confirmation only — the server rejects it if no profile exists yet
      case "setup-verify-scripts": {
        const setupScript = drafts[`${step.id}:setup`] ?? "";
        const verifyScript = drafts[`${step.id}:verify`] ?? "";
        if (!setupScript.trim() && !verifyScript.trim()) return null;
        const input: Record<string, unknown> = {};
        if (setupScript.trim()) input.setupScript = setupScript;
        if (verifyScript.trim()) input.verifyScript = verifyScript;
        return input;
      }
      case "start-mode": {
        const value = drafts[step.id];
        return value ? { value } : null;
      }
      case "wip-limit": {
        const raw = drafts[step.id];
        const value = Number(raw);
        return raw && Number.isFinite(value) && value >= 1 ? { value } : null;
      }
      // Both are real settings with real editors already. A cramped second editor here would be
      // a worse version of an existing screen, so the wizard points at it instead of duplicating.
      // `extra-repos` additionally has no apply path at all — the server rejects it, because repos
      // are attached via POST /api/projects/:id/repos.
      case "strategy-bullseye":
      case "extra-repos":
        return "external";
      default:
        return {};
    }
  }

  function renderStepControls(step: OnboardingStep) {
    const busy = busyStepId === step.id;
    const terminal = step.status === "done" || step.status === "not-applicable";
    if (terminal) return null;

    const input = configInput(step);
    const external = input === "external";
    return (
      <div className="flex flex-wrap items-center gap-2">
        {step.kind === "config" && step.configKey === "setup-verify-scripts" && (
          <>
            <input
              value={drafts[`${step.id}:setup`] ?? ""}
              onChange={(e) => setDrafts((d) => ({ ...d, [`${step.id}:setup`]: e.target.value }))}
              placeholder="setup script (e.g. pnpm install -r)"
              className="min-w-0 flex-1 rounded border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1 text-xs"
            />
            <input
              value={drafts[`${step.id}:verify`] ?? ""}
              onChange={(e) => setDrafts((d) => ({ ...d, [`${step.id}:verify`]: e.target.value }))}
              placeholder="verify script (e.g. pnpm test)"
              className="min-w-0 flex-1 rounded border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1 text-xs"
            />
          </>
        )}
        {step.kind === "config" && step.configKey === "start-mode" && (
          <select
            value={drafts[step.id] ?? ""}
            onChange={(e) => setDrafts((d) => ({ ...d, [step.id]: e.target.value }))}
            className="rounded border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1 text-xs"
          >
            <option value="">Pick a mode…</option>
            {START_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        )}
        {step.kind === "config" && step.configKey === "wip-limit" && (
          <input
            type="number"
            min={1}
            value={drafts[step.id] ?? ""}
            onChange={(e) => setDrafts((d) => ({ ...d, [step.id]: e.target.value }))}
            placeholder="e.g. 2"
            className="w-24 rounded border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1 text-xs"
          />
        )}

        {external ? (
          <span className="text-[11px] text-gray-500 dark:text-gray-400">Set this in Settings → Project Settings.</span>
        ) : (
          <button
            type="button"
            disabled={busy || input === null}
            onClick={() => void act("apply", { stepId: step.id, input: input as Record<string, unknown> }, step.id)}
            title={input === null ? "Fill in a value first" : undefined}
            data-testid={`onboarding-apply-${step.id}`}
            className="rounded bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? "Working…" : step.kind === "config" ? "Apply" : step.kind === "plugin" ? "Enable" : "File ticket"}
          </button>
        )}
        {step.status !== "skipped" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act("skip", { stepId: step.id }, step.id)}
            data-testid={`onboarding-skip-${step.id}`}
            className="rounded border border-gray-300 dark:border-gray-600 px-2.5 py-1 text-xs hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            Skip
          </button>
        )}
      </div>
    );
  }

  const steps = plan?.steps ?? [];
  const remaining = steps.filter((s) => s.status === "pending").length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) closeOnboarding(); }}
    >
      <div className="mx-4 flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg bg-surface-raised dark:bg-surface-raised-dark shadow-xl">
        <div className="border-b border-gray-200 dark:border-gray-700 p-5">
          <h2 className="text-lg font-semibold text-ink dark:text-stone-100">
            Set up {projectName ?? "this project"}
          </h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {justImported
              ? "The repo is registered and scaffolded. These are the steps left before the board can drive it — all of them are optional and you can close this at any time."
              : "What is left before the board can drive this project. Steps already done are shown for reference."}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading && <p className="text-sm text-gray-500 dark:text-gray-400">Loading plan…</p>}
          {error && (
            <p className="mb-3 rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-2 py-1 text-xs text-red-800 dark:text-red-300">
              {error}
            </p>
          )}
          {!loading && steps.length === 0 && !error && (
            <p className="text-sm text-gray-500 dark:text-gray-400">Nothing to configure for this project.</p>
          )}

          {SECTIONS.map((section) => {
            const sectionSteps = steps.filter((s) => s.kind === section.kind);
            if (sectionSteps.length === 0) return null;
            return (
              <section key={section.kind} className="mb-5" data-testid={`onboarding-section-${section.kind}`}>
                <h3 className="text-sm font-medium text-ink dark:text-stone-100">{section.title}</h3>
                <p className="mb-2 text-[11px] text-gray-500 dark:text-gray-400">{section.blurb}</p>
                <ul className="space-y-1.5">
                  {sectionSteps.map((step) => (
                    <li
                      key={step.id}
                      data-testid={`onboarding-step-${step.id}`}
                      data-step-status={step.status}
                      className="rounded border border-gray-200 dark:border-gray-700 px-2.5 py-2"
                    >
                      <div className="flex items-start gap-2">
                        <StatusChip status={step.status} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2">
                            <span className="text-xs font-medium text-ink dark:text-stone-100">{step.title}</span>
                            {!step.optional && <span className="text-[10px] text-amber-700 dark:text-amber-400">recommended</span>}
                          </div>
                          {/* A done step keeps its title and status but drops the rationale and
                              its controls — it is reference, not work. */}
                          {step.status !== "done" && (
                            <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{step.rationale}</p>
                          )}
                        </div>
                      </div>
                      {step.status !== "done" && <div className="mt-1.5 pl-6">{renderStepControls(step)}</div>}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-200 dark:border-gray-700 p-4">
          <span className="text-[11px] text-gray-500 dark:text-gray-400" data-testid="onboarding-remaining">
            {remaining === 0 ? "Nothing left to do." : `${remaining} step${remaining === 1 ? "" : "s"} left`}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={closeOnboarding}
              className="rounded border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => void dismiss()}
              data-testid="onboarding-dismiss"
              className="rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              Done — don't show again
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
