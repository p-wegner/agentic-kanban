import { useCallback, useEffect, useState } from "react";
// Deep path, not the root barrel: #463 exports the plan model as its own entry point. The module
// is pure strings + data (no Node builtins), so it is safe in the client bundle.
import type { OnboardingPlan, OnboardingStep } from "@agentic-kanban/shared/lib/onboarding-plan";
import { apiFetch, apiPost } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { useOnboardingStore } from "../stores/onboardingStore.js";
import { usePluginViewStore } from "../stores/pluginViewStore.js";
import { normalizeConfig, setProviderFillPolicy, type ConcreteProvider } from "../lib/strategy-targets.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * Onboarding wizard (#464, paged in #475) — takes a freshly imported project from "it shows on
 * the board" to "the board can actually drive it".
 *
 * Registration stops at `scaffoldAndPopulateProject`: stack profile, setup/verify scripts, hooks,
 * starter docs. Everything after that (Start Mode — which defaults to `manual`, so NOTHING
 * auto-starts — WIP, plugins, project-scoped init skills, a non-empty backlog) was left for the
 * user to find in Settings or never happened at all. This renders the plan from #463 as a
 * checklist, one section at a time, and applies one step at a time.
 *
 * Two rules it inherits from the plan model and must not break:
 *  - **Status is derived server-side.** Every apply/skip returns the recomputed plan and we render
 *    THAT, rather than optimistically flipping a local flag. A local copy would drift from the
 *    board's own view of the world, which is the bug the derived-status design exists to prevent.
 *  - **Nothing here runs an agent.** `init-skill` and `ticket` steps file a ticket; the user can
 *    see, edit or delete it, and it goes through the normal workspace/review/merge flow.
 */

export const SECTIONS: { kind: OnboardingStep["kind"]; title: string; blurb: string }[] = [
  { kind: "config", title: "Detected setup", blurb: "How the board provisions, verifies and drives this project." },
  { kind: "plugin", title: "Plugins", blurb: "Optional. Enabling one materializes its skills into the repo." },
  { kind: "init-skill", title: "Init skills", blurb: "One-time passes over a fresh codebase. Each files a ticket — nothing runs now." },
  { kind: "ticket", title: "Suggested first tickets", blurb: "A starter backlog, so the board has something to pick up." },
];

/** Sections that have at least one step — an empty section (e.g. no plugins installed) is never
 *  its own page. Order-preserving; pure so the paging rules are directly testable. */
export function visibleOnboardingSections(steps: OnboardingStep[]): typeof SECTIONS {
  return SECTIONS.filter((section) => steps.some((s) => s.kind === section.kind));
}

/** Which page the wizard is showing: one of the visible sections, or the closing summary. */
export type OnboardingWizardPage = { kind: "section"; index: number } | { kind: "summary" };

/** Next section, or the summary once the last section's Next is clicked. Idempotent on summary. */
export function nextWizardPage(page: OnboardingWizardPage, sectionCount: number): OnboardingWizardPage {
  if (page.kind === "summary") return page;
  return page.index + 1 < sectionCount ? { kind: "section", index: page.index + 1 } : { kind: "summary" };
}

/** Previous section; from the summary, back to the last section. Clamps at the first section. */
export function prevWizardPage(page: OnboardingWizardPage, sectionCount: number): OnboardingWizardPage {
  if (page.kind === "summary") return { kind: "section", index: Math.max(0, sectionCount - 1) };
  return { kind: "section", index: Math.max(0, page.index - 1) };
}

const START_MODES = [
  { value: "manual", label: "Manual — nothing auto-starts" },
  { value: "monitor", label: "Monitor — the board starts backlog tickets up to the WIP limit" },
  { value: "conductor", label: "Conductor — an out-of-process loop drives this project" },
];

type StepStatus = OnboardingStep["status"];

/** Draft values the user has typed, keyed by step id (setup/verify use `<id>:setup` / `<id>:verify`). */
export type OnboardingDrafts = Record<string, string>;

/**
 * What to send when applying a step — or why it can't be applied yet.
 *
 * - an object: ready, send it as `input`
 * - `null`: the step needs a value the user has not supplied, so Apply stays disabled
 *
 * Pure and exported so the enable/disable rules are testable — the component itself fetches on
 * mount, which the repo's static-markup test convention cannot exercise.
 */
export function onboardingStepInput(
  step: OnboardingStep,
  drafts: OnboardingDrafts,
): Record<string, unknown> | null {
  if (step.kind === "plugin") {
    // #473: enabling scaffolds immediately, so — exactly like the marketplace panel — the
    // leading/sidecar choice must be made BEFORE Enable is even clickable, never defaulted.
    const location = drafts[`${step.id}:location`];
    return location === "leading" || location === "sidecar" ? { location } : null;
  }
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
    case "strategy-bullseye": {
      // #475: a minimal per-project provider/profile picker, not the full Strategy Targets
      // editor. Writes a single "fill" provider policy — exactly what Settings → Agent's
      // simple per-project provider control writes — through the same onboarding/apply path,
      // which the server persists via `setPreferenceChecked` (regenerates objective.md, runs
      // the #903 divergence guard).
      const provider = drafts[`${step.id}:provider`];
      if (provider !== "claude" && provider !== "codex" && provider !== "copilot" && provider !== "pi") return null;
      const profileName = (drafts[`${step.id}:profile`] ?? "").trim();
      const config = setProviderFillPolicy(normalizeConfig({}), provider as ConcreteProvider, profileName);
      return { value: JSON.stringify(config) };
    }
    // #475: extra-repos has its OWN dedicated control (POST /api/projects/:id/repos) instead
    // of the generic onboarding/apply endpoint — the server rejects that endpoint for this key.
    // renderStepControls short-circuits before ever consulting this value; null is defensive.
    case "extra-repos":
      return null;
    default:
      return {};
  }
}

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
  // #475: one section per page, plus a closing summary — see visibleOnboardingSections/
  // nextWizardPage/prevWizardPage above for the (tested) paging rules this drives.
  const [page, setPage] = useState<OnboardingWizardPage>({ kind: "section", index: 0 });

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      setPlan(await apiFetch<OnboardingPlan>(`/api/projects/${id}/onboarding`));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setPage({ kind: "section", index: 0 });
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
      const message = errorMessage(err);
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

  /** #475: extra-repos proxies straight to the repos endpoint, never the onboarding/apply one
   *  (the server rejects that for this key) — so it needs its own request + refresh, not `act`. */
  async function applyExtraRepo(step: OnboardingStep) {
    const raw = (drafts[`${step.id}:repo`] ?? "").trim();
    if (!raw || !projectId) return;
    setBusyStepId(step.id);
    setError(null);
    try {
      const body = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.endsWith(".git") ? { cloneUrl: raw } : { path: raw };
      await apiPost(`/api/projects/${projectId}/repos`, body);
      setDrafts((d) => ({ ...d, [`${step.id}:repo`]: "" }));
      // The step's status is derived from listProjectRepos, so a plain plan reload is enough
      // to flip it to done — same "never optimistic" contract as every other step.
      await load(projectId);
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      showToast(message, "error");
    } finally {
      setBusyStepId(null);
    }
  }

  function renderExtraReposControl(step: OnboardingStep) {
    const busy = busyStepId === step.id;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={drafts[`${step.id}:repo`] ?? ""}
          onChange={(e) => setDrafts((d) => ({ ...d, [`${step.id}:repo`]: e.target.value }))}
          placeholder="Repo path or git URL"
          data-testid={`onboarding-repo-input-${step.id}`}
          className="min-w-0 flex-1 rounded border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1 text-xs"
        />
        <button
          type="button"
          disabled={busy || !(drafts[`${step.id}:repo`] ?? "").trim()}
          onClick={() => void applyExtraRepo(step)}
          data-testid={`onboarding-apply-${step.id}`}
          className="rounded bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? "Working…" : "Add repo"}
        </button>
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

  function renderStepControls(step: OnboardingStep) {
    const busy = busyStepId === step.id;
    const terminal = step.status === "done" || step.status === "not-applicable";
    if (terminal) return null;
    if (step.kind === "config" && step.configKey === "extra-repos") return renderExtraReposControl(step);

    const input = onboardingStepInput(step, drafts);
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
        {step.kind === "config" && step.configKey === "strategy-bullseye" && (
          <>
            <select
              value={drafts[`${step.id}:provider`] ?? ""}
              onChange={(e) => setDrafts((d) => ({ ...d, [`${step.id}:provider`]: e.target.value }))}
              aria-label="Provider"
              data-testid={`onboarding-bullseye-provider-${step.id}`}
              className="rounded border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1 text-xs"
            >
              <option value="">Pick a provider…</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="copilot">Copilot</option>
              <option value="pi">Pi</option>
            </select>
            <input
              value={drafts[`${step.id}:profile`] ?? ""}
              onChange={(e) => setDrafts((d) => ({ ...d, [`${step.id}:profile`]: e.target.value }))}
              placeholder="profile (optional)"
              data-testid={`onboarding-bullseye-profile-${step.id}`}
              className="min-w-0 flex-1 rounded border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1 text-xs"
            />
          </>
        )}
        {step.kind === "plugin" && (
          <select
            value={drafts[`${step.id}:location`] ?? ""}
            onChange={(e) => setDrafts((d) => ({ ...d, [`${step.id}:location`]: e.target.value }))}
            title="Where this plugin writes its output. Choose before enabling — enabling writes the scaffold."
            aria-label="Plugin output location"
            data-testid={`onboarding-plugin-location-${step.id}`}
            className="rounded border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1 text-xs"
          >
            <option value="">Choose output location…</option>
            <option value="leading">Output: leading repo</option>
            <option value="sidecar">Output: sidecar repo</option>
          </select>
        )}

        <button
          type="button"
          disabled={busy || input === null}
          onClick={() => void act("apply", { stepId: step.id, input: input as Record<string, unknown> }, step.id)}
          title={input === null ? "Fill in a value first" : undefined}
          data-testid={`onboarding-apply-${step.id}`}
          className="rounded bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy
            ? "Working…"
            : step.kind === "config"
              ? "Apply"
              : step.kind === "plugin"
                ? (step.installSource ? "Install & enable" : "Enable")
                : "File ticket"}
        </button>
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

  function renderSection(section: (typeof SECTIONS)[number]) {
    const sectionSteps = steps.filter((s) => s.kind === section.kind);
    return (
      <section data-testid={`onboarding-section-${section.kind}`}>
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
                  {/* #473: enabled ≠ usable — an unfilled scaffold blocks every script/loop
                      (requireScaffoldReady), so a bare ✓ here would be a lie. Shown even on
                      a "done" step, since that's exactly when this matters. */}
                  {step.kind === "plugin" && step.scaffoldPlaceholders > 0 && (
                    <p
                      className="mt-0.5 rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-1.5 py-0.5 text-[11px] text-amber-800 dark:text-amber-300"
                      data-testid={`onboarding-scaffold-placeholders-${step.id}`}
                    >
                      ⚠ {step.scaffoldPlaceholders} scaffold placeholder{step.scaffoldPlaceholders === 1 ? "" : "s"} still need filling in —{" "}
                      <button
                        type="button"
                        onClick={() => {
                          if (step.pluginSlug) usePluginViewStore.getState().setSelection({ kind: "plugin", slug: step.pluginSlug });
                          closeOnboarding();
                        }}
                        data-testid={`onboarding-scaffold-open-${step.id}`}
                        className="underline hover:no-underline"
                      >
                        fill them in on the Plugins tab
                      </button>
                      .
                    </p>
                  )}
                </div>
              </div>
              {step.status !== "done" && <div className="mt-1.5 pl-6">{renderStepControls(step)}</div>}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  function renderSummary() {
    const applied = steps.filter((s) => s.status === "done");
    const skipped = steps.filter((s) => s.status === "skipped");
    const stillPending = steps.filter((s) => s.status === "pending");
    return (
      <div data-testid="onboarding-summary">
        <h3 className="text-sm font-medium text-ink dark:text-stone-100">Setup summary</h3>
        <p className="mb-2 text-[11px] text-gray-500 dark:text-gray-400">
          {applied.length} applied, {skipped.length} skipped, {stillPending.length} still to do.
        </p>
        <ul className="space-y-1">
          {steps.filter((s) => s.status !== "not-applicable").map((s) => (
            <li key={s.id} className="flex items-center gap-2 text-xs text-ink dark:text-stone-100">
              <StatusChip status={s.status} />
              <span>{s.title}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const steps = plan?.steps ?? [];
  const remaining = steps.filter((s) => s.status === "pending").length;
  const visibleSections = visibleOnboardingSections(steps);
  const hasPages = steps.length > 0;

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
          {hasPages && (
            <div className="mt-3" data-testid="onboarding-progress">
              <div className="flex gap-1">
                {visibleSections.map((section, i) => (
                  <span
                    key={section.kind}
                    className={`h-1.5 flex-1 rounded ${
                      (page.kind === "section" && i <= page.index) || page.kind === "summary"
                        ? "bg-brand-600"
                        : "bg-gray-200 dark:bg-gray-700"
                    }`}
                  />
                ))}
              </div>
              <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400" data-testid="onboarding-page-label">
                {page.kind === "summary"
                  ? "Summary"
                  : `Step ${page.index + 1} of ${visibleSections.length}: ${visibleSections[page.index]?.title ?? ""}`}
              </p>
            </div>
          )}
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

          {!loading && hasPages && page.kind === "section" && visibleSections[page.index] && renderSection(visibleSections[page.index])}
          {!loading && hasPages && page.kind === "summary" && renderSummary()}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-200 dark:border-gray-700 p-4">
          <span className="text-[11px] text-gray-500 dark:text-gray-400" data-testid="onboarding-remaining">
            {remaining === 0 ? "Nothing left to do." : `${remaining} step${remaining === 1 ? "" : "s"} left`}
          </span>
          <div className="flex gap-2">
            {hasPages && (
              <button
                type="button"
                disabled={page.kind === "section" && page.index === 0}
                onClick={() => setPage(prevWizardPage(page, visibleSections.length))}
                data-testid="onboarding-back"
                className="rounded border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
              >
                Back
              </button>
            )}
            {hasPages && page.kind === "section" && (
              <button
                type="button"
                onClick={() => setPage(nextWizardPage(page, visibleSections.length))}
                data-testid="onboarding-next"
                className="rounded border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                {page.index + 1 < visibleSections.length ? "Next" : "Review summary"}
              </button>
            )}
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
