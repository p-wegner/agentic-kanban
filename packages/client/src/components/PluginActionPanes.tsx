import { useEffect, useMemo, useState } from "react";
import { apiFetch, apiPost } from "../lib/api.js";
import { showToast } from "./Toast.js";
import { setProjectPref } from "../lib/settingsStore.js";
import { requestIssueFocus, requestViewNavigation } from "../lib/navigateView.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { checkLocationTokens } from "../lib/gateCardPolicy.js";
import { deriveProductIdentity, type ProductIdentity, type ScaffoldForm } from "./PluginScaffoldPane.js";
import {
  ArtifactViewer,
  AwaitingMergeCard,
  ChecksBadges,
  GateCard,
  LoopStateChips,
  LoopTimeline,
  ProgressStepper,
  type LoopStall,
  type LoopUnitCost,
  type PluginCheck,
  type PluginGate,
  type PluginProgressStep,
  type StartPolicy,
} from "./PluginLoopExtras.js";

/**
 * The non-iframe halves of the board's Plugins panel: the panes for a plugin's
 * converging LOOPS, one-shot SCRIPTS, and agentic SKILLS. Split out of
 * PluginViewsPanel so the view host stays about hosting views.
 *
 * All three do the same shape of work (POST, show a result, report an error), but
 * they are deliberately NOT one generic pane: what "success" means differs enough
 * to matter to the user — a loop reports rounds and convergence, a script an exit
 * code and output, a skill a ticket number — and flattening them into a shared
 * result blob is how a UI stops answering the question the user actually has.
 */

/**
 * Loop tickets, named AND reachable (#413). Clicking switches to the board and opens the
 * issue's detail panel — the pane used to print a bare "1 ticket(s) still open" and leave
 * the reader to query the API for which one, which is precisely how a phantom hid.
 */
function OpenTicketLinks({ refs }: { refs: Array<{ issueId: string; issueNumber: number | null; statusName: string }> }) {
  return (
    <>
      {refs.map((ref, i) => (
        <span key={ref.issueId}>
          {i > 0 && ", "}
          <button
            type="button"
            onClick={() => {
              requestViewNavigation("kanban");
              requestIssueFocus({ issueId: ref.issueId, issueNumber: ref.issueNumber });
            }}
            className="font-mono underline underline-offset-2 hover:no-underline"
            title="Open this ticket on the board"
            data-testid="plugin-loop-ticket-link"
          >
            #{ref.issueNumber ?? "?"}
          </button>
          <span className="opacity-75"> ({ref.statusName})</span>
        </span>
      ))}
    </>
  );
}

// Declared once, in shared (#569) — the server builds the same shape in
// services/plugin-enabled.ts.
export type { PluginOwner } from "@agentic-kanban/shared";

import type { PluginOwner } from "@agentic-kanban/shared";

export type PluginLoop = PluginOwner & {
  name: string;
  label: string;
  description: string | null;
  skill: string;
  openTickets: number;
  /** The open tickets themselves (#429), so the pane can name them rather than only count them. */
  openTicketRefs?: Array<{
    issueId: string;
    issueNumber: number | null;
    statusName: string;
    /** Open, has had a workspace, none live — nothing will ever close it (#413/#397). */
    stranded?: boolean;
  }>;
  /**
   * Open tickets that belong to a round still in flight (#431) — the gate renders when this is
   * empty. NOT the same question as `openTickets === 0`, which includes the gate's own ticket.
   */
  gateBlockedBy?: Array<number | null>;
  closedTickets: number;
  paused: boolean;
  converged: boolean;
  note: string | null;
  lastAdvanceAt: string | null;
  gate: PluginGate | null;
  /**
   * When the current gate was first reached. Use this — never `lastAdvanceAt` — to show how
   * long a decision has been waiting: the monitor re-plans a gated loop every cycle, so
   * `lastAdvanceAt` keeps moving while nobody has acted.
   */
  gateSince?: string | null;
  progress: { steps: PluginProgressStep[] } | null;
  checks: PluginCheck[] | null;
  totalCostUsd?: number;
  /**
   * Finished-but-unlanded loop ticket (#299) — the silent-stall state, now named. Since #363 it
   * also carries a workspace parked `ready_for_merge` whose issue never advanced; check
   * `mergeSafe` before offering to land it.
   */
  awaitingMerge?: LoopStall | null;
  /** The butler's pre-read verdict for the current gate (#309). */
  gateRecommendation?: { actionId: string; reason: string } | null;
};

export type PluginScript = PluginOwner & {
  name: string;
  label: string;
  description: string | null;
  command: string;
};

export type PluginSkill = PluginOwner & {
  name: string;
  description: string | null;
  /** Workflow the manifest declares for this skill (builtin key or name); null = board default. */
  workflow?: string | null;
};

type LoopAdvanceResult = {
  loop: string;
  converged: boolean;
  note: string | null;
  planned: number;
  created: Array<{ unitId: string; issueId: string; issueNumber: number | null; title: string; artifacts?: string[] }>;
  skippedExisting: Array<{ unitId: string; issueNumber: number | null; statusName: string }>;
  capped: number;
  startMode: string;
  warnings: string[];
}

type ScriptRunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

export function PaneHeading({ title, subtitle, mono, identity }: {
  title: string;
  subtitle?: string | null;
  mono?: boolean;
  /** The product this pane's work is FOR (#455) — stated above the pane's own name. */
  identity?: string | null;
}) {
  return (
    <div className="space-y-1">
      {identity && (
        <p
          className="text-xs font-medium text-gray-700 dark:text-gray-200"
          data-testid="plugin-pane-product-identity"
          title={identity}
        >
          {identity}
        </p>
      )}
      <h2 className={`text-base font-medium text-gray-900 dark:text-gray-100 ${mono ? "font-mono" : ""}`}>{title}</h2>
      {subtitle && <p className="text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>}
    </div>
  );
}

/**
 * The identifiers the gate's checks quote, as the artifact viewer's jump chips (#457/#452).
 *
 * Union over the checks that can actually withdraw an approval — a passing check names nothing
 * the reviewer has to go and find. Order preserved (blocking findings tend to be listed in the
 * order they matter), deduped, capped: a chip that finds nothing is worse than no chip.
 */
export function gateFindHints(checks?: PluginCheck[] | null, limit = 6): string[] {
  const tokens: string[] = [];
  for (const check of checks ?? []) {
    if (check.verdict === "pass") continue;
    for (const token of checkLocationTokens(check.detail)) {
      if (!tokens.includes(token)) tokens.push(token);
    }
  }
  return tokens.slice(0, limit);
}

/**
 * The token an artifact opened FROM the gate should land on (#457/#452).
 *
 * Only `fail` arms it: a `warn` is usually a summary rather than a location, and an artifact
 * opened from the stepper is being read rather than adjudicated — pushing that to the raw tab
 * mid-search would be wrong. Undefined when no failing check quotes anything, which leaves the
 * viewer exactly as it was.
 */
export function gateInitialFind(checks?: PluginCheck[] | null): string | undefined {
  for (const check of checks ?? []) {
    if (check.verdict !== "fail") continue;
    const [first] = checkLocationTokens(check.detail);
    if (first) return first;
  }
  return undefined;
}

/**
 * Tailwind for the loop pane's two review layouts (#447) — see the long note at the render.
 *
 * `stacked` is today's single scrolling column and must stay byte-identical to it, because the
 * sub-`sm` full-screen sheet (#434) and the 44px touch targets were measured against it.
 * `split` only ever engages at `lg`, so every difference is behind an `lg:` variant.
 */
export function loopPaneLayoutClasses(artifactOpen: boolean): { pane: string; decisionColumn: string } {
  const pane = "p-3 sm:p-6 space-y-4 overflow-y-auto";
  const column = "space-y-4";
  if (!artifactOpen) return { pane, decisionColumn: column };
  return {
    pane: `${pane} lg:flex lg:flex-row lg:items-stretch lg:gap-4 lg:space-y-0 lg:p-4 lg:flex-1 lg:min-h-0 lg:overflow-hidden`,
    // `flex flex-col` + `gap` rather than the stacked `space-y`: the column REORDERS at `lg`
    // (the gate leads), and `space-y` puts its margins by DOM order, which reordering breaks.
    decisionColumn:
      `${column} lg:flex lg:flex-col lg:gap-4 lg:space-y-0 lg:w-[26rem] xl:w-[32rem] lg:shrink-0 lg:min-h-0 lg:overflow-y-auto lg:pr-1`,
  };
}

/** Converging analysis loop: advance a round, then let the board's monitor run it. */
export function PluginLoopPane({ loop, projectId, onChanged, startPolicy = null, setupRequired = null }: {
  loop: PluginLoop;
  projectId: string;
  onChanged: () => void;
  startPolicy?: StartPolicy;
  /**
   * Set when the plugin's scaffold still has unresolved TODO markers (#427). Every advance
   * 409s in that state, so the pane must say so BEFORE the click rather than only in the
   * toast afterwards — on a fresh project this pane opened with "Start loop" as the primary
   * action when refusal was the only possible outcome.
   */
  setupRequired?: { pendingFields: number; targetPath: string; onOpenSetup: () => void } | null;
}) {
  const [advancing, setAdvancing] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [result, setResult] = useState<LoopAdvanceResult | null>(null);
  const [openArtifact, setOpenArtifact] = useState<string | null>(null);
  /**
   * The step the open artifact came from (#422/#423) — supplies the viewer's header and
   * its sibling picker. Null when the artifact was opened from the gate card or the unit
   * list, which are per-file and carry no step.
   */
  const [openArtifactStep, setOpenArtifactStep] = useState<
    { label: string; version?: string; artifacts?: string[]; index: number; total: number } | null
  >(null);
  const [timelineKey, setTimelineKey] = useState(0);
  // Line-anchored review notes collected on the artifact diff (#304).
  const [lineNotes, setLineNotes] = useState<string[]>([]);
  const [switchingMode, setSwitchingMode] = useState(false);
  /**
   * Per-unit agent cost for the stepper (#457/#453). The events endpoint computes the cost
   * rollup independently of the event window, so `limit=1` buys the whole `byUnit` join for
   * the price of one row — the timeline's own fetch (limit=200, ~1 MB on a long-lived loop)
   * is not duplicated here.
   */
  const [costByUnit, setCostByUnit] = useState<LoopUnitCost[] | null>(null);
  /**
   * What product this pipeline is building (#455). Sourced from the plugin's scaffold profile
   * the same way PluginViewsPanel fetches it, then reduced by the profile pane's own
   * `deriveProductIdentity` so the two panes cannot disagree. Silent on failure: a plugin with
   * no scaffold (404) or an unreadable profile simply keeps today's header.
   */
  const [identity, setIdentity] = useState<ProductIdentity | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCostByUnit(null);
    apiFetch<{ cost: { byUnit: LoopUnitCost[] } }>(
      `/api/plugins/${loop.pluginId}/loops/${encodeURIComponent(loop.name)}/events`
      + `?projectId=${projectId}&limit=1`,
    )
      .then((res) => { if (!cancelled) setCostByUnit(res.cost?.byUnit ?? null); })
      .catch(() => { /* cost is decoration — a failure must not blank the pane */ });
    return () => { cancelled = true; };
  }, [loop.pluginId, loop.name, projectId, timelineKey]);

  useEffect(() => {
    let cancelled = false;
    setIdentity(null);
    apiFetch<ScaffoldForm>(`/api/plugins/${loop.pluginId}/scaffold?projectId=${projectId}`)
      .then((res) => { if (!cancelled) setIdentity(deriveProductIdentity(res.content)); })
      .catch(() => { /* 404 = this plugin declares no scaffold */ });
    return () => { cancelled = true; };
  }, [loop.pluginId, projectId]);

  /** The viewer's jump chips and its opening search, derived from the gate's checks (#457). */
  const findHints = useMemo(() => gateFindHints(loop.checks), [loop.checks]);
  const initialFind = useMemo(() => gateInitialFind(loop.checks), [loop.checks]);
  /** Set when the open artifact came from the gate card, i.e. it is the thing under review. */
  const [artifactFromGate, setArtifactFromGate] = useState(false);

  /**
   * One-click fix for the manual-Start-Mode warning (#428): the loop planned tickets that
   * nothing will start. Writes the same `start_mode` project preference the Monitor view's
   * control writes. It deliberately does NOT touch the Conductor: this only ever moves
   * manual → monitor, and a project in manual has no conductor loop running to stop.
   */
  async function switchToMonitorMode() {
    if (switchingMode) return;
    setSwitchingMode(true);
    try {
      await setProjectPref(projectId, "start_mode", "monitor");
      showToast("Start Mode set to monitor — the board will start this loop's tickets", "success");
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to change Start Mode", "error");
    } finally {
      setSwitchingMode(false);
    }
  }

  async function advance() {
    if (advancing) return;
    setAdvancing(true);
    try {
      const res = await apiPost<LoopAdvanceResult>(
        `/api/plugins/${loop.pluginId}/loops/${encodeURIComponent(loop.name)}/advance`,
        { projectId },
      );
      setResult(res);
      setTimelineKey((k) => k + 1);
      showToast(
        res.created.length > 0
          ? `Planned ${res.created.length} ticket(s) for "${loop.label}"`
          : res.converged
            ? `"${loop.label}" has converged`
            : `No new work for "${loop.label}"`,
        "success",
      );
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Loop advance failed", "error");
    } finally {
      setAdvancing(false);
    }
  }

  async function togglePause() {
    if (pausing) return;
    setPausing(true);
    try {
      await apiPost(
        `/api/plugins/${loop.pluginId}/loops/${encodeURIComponent(loop.name)}/${loop.paused ? "resume" : "pause"}`,
        { projectId },
      );
      showToast(loop.paused ? `"${loop.label}" resumed` : `"${loop.label}" paused`, "success");
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Loop pause/resume failed", "error");
    } finally {
      setPausing(false);
    }
  }

  const roundRunning = loop.openTickets > 0;
  const strandedRefs = (loop.openTicketRefs ?? []).filter((ref) => ref.stranded);
  const liveRefs = (loop.openTicketRefs ?? []).filter((ref) => !ref.stranded);
  /**
   * #447 — reading the artifact and deciding on it used to be mutually exclusive.
   *
   * MEASURED on the live `mealplan` step-7 gate at 1440x900: the viewer mounted BELOW the gate
   * card and the stats row, so the document and the Approve/Revise buttons were never on screen
   * together — you scrolled down to read and back up to act, losing the checks and the butler
   * verdict on the way. Meanwhile the gate card was `max-w-2xl` in a ~1200px pane (~500px of
   * empty whitespace) and the artifact was squeezed into a `max-h-[60vh]` NESTED scroller.
   *
   * So from `lg` up, an open artifact turns the pane into the review shape the board already
   * uses for diffs: the document on the left taking the full pane height with its own scroll,
   * the decision column on the right with its own. Two SIBLING scrollers — the pane itself
   * stops scrolling in that mode, which is what removes the nesting.
   *
   * Below `lg` nothing changes: the pane scrolls as one column, and below `sm` the viewer is
   * still the full-screen sheet (#434, a measured fix — a 60vh box inside a scrolling pane is
   * unusable on a phone). The one visible difference in the stacked layout is that the viewer
   * now sits at the BOTTOM of the pane rather than between the advance result and the timeline;
   * it scrolls itself into view on open (#288), and below `sm` it is a sheet, so its position
   * in the flow is not what the reader navigates by.
   */
  const splitReview = !!openArtifact;
  const layout = loopPaneLayoutClasses(splitReview);
  return (
    <div
      className={layout.pane}
      data-testid="plugin-loop-pane"
      data-review-layout={splitReview ? "split" : "stacked"}
    >
      {/* The decision column: everything that is not the document under review. It keeps its
          own scroll at `lg` so the gate's buttons stay reachable while the artifact scrolls. */}
      <div className={layout.decisionColumn} data-testid="plugin-loop-decision-column">
      {/* `order-first` on the header and the gate, so in the split layout the column opens on
          WHAT is being decided and the decision itself. MEASURED without it: the 9-row stepper,
          the checks strip and the stats row pushed the Approve/Revise buttons to y=1213 in a
          900px viewport — co-visible with the artifact in principle, off screen in fact. The
          class is inert in the stacked layout, where the column is not a flex container. */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-3 lg:order-first">
        <PaneHeading
          title={loop.label}
          subtitle={loop.description}
          /* #455 — the pane never said WHICH product this pipeline is building, so deciding
             "approve step 7 of a pipeline for what?" after a 13h gap meant opening step 2's
             PRD. Degrades silently to today's header when the profile names neither. */
          identity={identity?.oneLiner ?? null}
        />
        <LoopStateChips
          loop={loop}
          startPolicy={startPolicy}
          onSwitchToMonitor={() => void switchToMonitorMode()}
          switchingMode={switchingMode}
        />
      </div>

      {/* Setup gate (#427): the server 409s every advance while the scaffold has unresolved
          markers, so say it here — persistently — instead of only in the toast after the click. */}
      {setupRequired && (
        <div
          className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 max-w-2xl flex items-start gap-2"
          data-testid="plugin-loop-setup-required"
        >
          <span aria-hidden="true">🛠️</span>
          <div className="flex-1 text-xs text-amber-900 dark:text-amber-200">
            <span className="font-medium">Setup required before this loop can run.</span>{" "}
            {setupRequired.pendingFields} unanswered field{setupRequired.pendingFields === 1 ? "" : "s"} in{" "}
            <span className="font-mono">{setupRequired.targetPath}</span> — the plugin&apos;s agents work from
            that profile, so every advance is refused until it is filled in.
          </div>
          <button
            type="button"
            onClick={setupRequired.onOpenSetup}
            className="shrink-0 text-[11px] px-2 py-0.5 rounded border border-amber-400 dark:border-amber-600 hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-900 dark:text-amber-200"
          >
            Fill it in
          </button>
        </div>
      )}
      {/* Collapsed by default: this is unchanging documentation of how loops work in general,
          identical on every loop and every visit, and it cost ~90px at the top of the pane —
          which pushed the gate's ACTION BUTTONS below the fold on a 720px viewport. The thing
          the reader came for (the gate, its verdict, its buttons) outranks the explainer. */}
      <details className="max-w-2xl">
        <summary className="text-xs text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300">
          How this loop works
        </summary>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          A board-owned loop. Each advance asks the plugin what work is still outstanding and turns every unit
          into a ticket carrying the <span className="font-mono">{loop.skill}</span> skill. The board&apos;s monitor
          starts those tickets within this project&apos;s WIP limit — so they use the same provider selection and
          profile rotation as any other ticket. Once a round&apos;s tickets are all closed the next round is planned
          automatically, until the plugin reports nothing left to do — or until the loop is paused.
        </p>
      </details>

      {/* Declarative pipeline progress (#289) + verification badges (#290). */}
      <ProgressStepper
        steps={loop.progress?.steps}
        activePath={openArtifact}
        /* #457 — per-step cost, joined `step-<n>:v<m>` → step id by `stepCost`. */
        costByUnit={costByUnit}
        onOpenStep={(step, index, total) => {
          setOpenArtifact(step.artifacts![0]);
          setOpenArtifactStep({ label: step.label, version: step.version, artifacts: step.artifacts, index, total });
          setArtifactFromGate(false);
        }}
        /* #457 — open the artifact that was actually clicked. Without this an artifact chip
           fell back to `onOpenStep`, which always opens `artifacts[0]`: on a step with three
           outputs, two of the three chips opened the wrong file. */
        onOpenStepArtifact={(step, artifactPath, index, total) => {
          setOpenArtifact(artifactPath);
          setOpenArtifactStep({ label: step.label, version: step.version, artifacts: step.artifacts, index, total });
          setArtifactFromGate(false);
        }}
      />
      <ChecksBadges checks={loop.checks} />

      {/* A finished step whose merge hasn't landed (#299) — the loop's silent-stall state. */}
      {loop.awaitingMerge && (
        <AwaitingMergeCard awaitingMerge={loop.awaitingMerge} onMergeStarted={onChanged} />
      )}

      {/*
        The human gate (#286): the single thing this loop needs from a person right now.

        #431 — the guard used to be `loop.openTickets === 0`, and `openTickets` counts the gate's
        OWN ticket. So anything holding that ticket non-terminal (a review parked for a human, a
        refused merge, an orphaned workspace from a crash) hid the gate — silently, behind a pane
        that looked like an ordinary running round. The server now says which open tickets belong
        to a round genuinely in flight; an absent field (an older cached response) renders the
        gate, since a stale gate is a far smaller failure than a missing current one.
      */}
      {loop.gate && (loop.gateBlockedBy ?? []).length === 0 && (
        <div className="lg:order-first">
        <GateCard
          pluginId={loop.pluginId}
          loopName={loop.name}
          projectId={projectId}
          gate={loop.gate}
          gateSince={loop.gateSince ?? null}
          checks={loop.checks}
          recommendation={loop.gateRecommendation ?? null}
          lineNotes={lineNotes}
          onOpenArtifact={(p) => { setOpenArtifact(p); setOpenArtifactStep(null); setArtifactFromGate(true); }}
          onResolved={() => { setTimelineKey((k) => k + 1); setLineNotes([]); onChanged(); }}
        />
        </div>
      )}
      {!loop.gate && loop.note && loop.openTickets === 0 && !loop.converged && (
        <p className="text-xs text-amber-700 dark:text-amber-400 max-w-2xl" data-testid="plugin-loop-note">
          {loop.note}
        </p>
      )}

      {/* wraps below sm: three stat boxes + Advance + Pause cannot share a phone line (#433) */}
      <div className="flex flex-wrap items-center gap-3 sm:gap-4 text-sm">
        <div className="px-3 py-2 rounded border border-gray-200 dark:border-gray-700">
          <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">{loop.openTickets}</div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400">open tickets</div>
        </div>
        <div className="px-3 py-2 rounded border border-gray-200 dark:border-gray-700">
          <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">{loop.closedTickets}</div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400">closed rounds</div>
        </div>
        {(loop.totalCostUsd ?? 0) > 0 && (
          <div className="px-3 py-2 rounded border border-gray-200 dark:border-gray-700" data-testid="plugin-loop-cost">
            <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">${loop.totalCostUsd!.toFixed(2)}</div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400">agent cost so far</div>
          </div>
        )}
        {/* #450 — while a gate is waiting, this button plans NOTHING by design (its own tooltip
            says so), and it was the only `bg-brand-600` control on the whole pane: the eye was
            drawn to the one thing that cannot help while the two real answers sat in the gate
            card below. It stays reachable — a replan is occasionally what you want — but the
            gate's decision is now the pane's only primary action. */}
        <button
          onClick={() => void advance()}
          disabled={advancing || !!setupRequired}
          className={`text-sm px-4 py-2.5 sm:px-3 sm:py-1.5 min-h-11 sm:min-h-0 rounded disabled:opacity-50 ${
            loop.gate
              ? "border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800"
              : "bg-brand-600 text-white hover:bg-brand-700"
          }`}
          data-testid="plugin-loop-advance"
          data-demoted={loop.gate ? "gate" : undefined}
          title={setupRequired
            ? `Fill in the ${setupRequired.pendingFields} outstanding profile field(s) first — the plugin refuses to plan without them`
            : loop.gate
              ? "A gate is waiting for a decision — advancing plans nothing until it is resolved. Answer the gate above."
              : roundRunning
                ? "The current round is still running — advancing now plans nothing new"
                : "Plan the next round"}
        >
          {advancing ? "Planning…" : loop.closedTickets === 0 && loop.openTickets === 0 ? "Start loop" : "Advance now"}
        </button>
        <button
          onClick={() => void togglePause()}
          disabled={pausing}
          className="text-sm px-4 py-2.5 sm:px-3 sm:py-1.5 min-h-11 sm:min-h-0 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
          data-testid="plugin-loop-pause-toggle"
          title={loop.paused
            ? "Resume — the monitor will auto-advance this loop again"
            : "Pause — stops the monitor from auto-advancing this loop; manual Advance still works"}
        >
          {pausing ? "Working…" : loop.paused ? "Resume" : "Pause"}
        </button>
      </div>

      {/* #413 — the stranded tickets get their OWN line, whether or not they are all of them.
          MEASURED live: eventhub's extraction loop held 28 open tickets of which 9 were
          stranded, so a warning that only fired when EVERY open ticket was stranded would
          have stayed silent on the shape that actually occurs. Nothing will close these, so
          "the next round is planned automatically once they close" is a promise the loop
          cannot keep — on roomsync it sat beside 9 ✓ step chips and a `converged: true` API. */}
      {strandedRefs.length > 0 && (
        <p
          className="text-xs rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-red-800 dark:text-red-300 max-w-2xl"
          data-testid="plugin-loop-stranded"
        >
          <span className="font-medium">
            {strandedRefs.length === 1 ? "A ticket is" : `${strandedRefs.length} tickets are`} stranded open with no
            live workspace
          </span>{" "}
          — <OpenTicketLinks refs={strandedRefs} />. Nothing is driving{" "}
          {strandedRefs.length === 1 ? "it" : "them"}, so {strandedRefs.length === 1 ? "it" : "they"} will not close on{" "}
          {strandedRefs.length === 1 ? "its" : "their"} own and the loop keeps waiting. Close or re-start{" "}
          {strandedRefs.length === 1 ? "it" : "them"} on the board (see #397), or press Advance to replan.
        </p>
      )}
      {roundRunning && liveRefs.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="plugin-loop-round-running">
          Round in progress — {liveRefs.length} ticket(s) still open
          {/* NAME the open tickets, their live status, and LINK to them (#429/#413). "1 ticket(s)
              still open" left the reader to go to the board and work out which one and whether it
              had actually started — the difference between "running" and "planned but nothing is
              provisioning it" is exactly what stalls here look like. The refs cost no extra query. */}
          {": "}<OpenTicketLinks refs={liveRefs} />
          . The next round is planned automatically once they close.
        </p>
      )}
      {/* No refs at all (an older surface payload) — keep the bare count rather than nothing. */}
      {roundRunning && (loop.openTicketRefs?.length ?? 0) === 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="plugin-loop-round-running">
          Round in progress — {loop.openTickets} ticket(s) still open. The next round is planned automatically once
          they close.
        </p>
      )}
      {loop.paused && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Paused — the monitor will not auto-advance this loop. Press Resume to let it converge hands-off again.
        </p>
      )}

      {result && (
        <div className="space-y-2 border-t border-gray-100 dark:border-gray-800 pt-3">
          <div className="text-sm text-gray-800 dark:text-gray-200">
            {result.converged && result.created.length === 0
              ? "Converged — the plugin reports no outstanding work."
              : `Planned ${result.planned} unit(s): ${result.created.length} new ticket(s), ${result.skippedExisting.length} already ticketed.`}
          </div>
          {result.note && <div className="text-xs text-gray-500 dark:text-gray-400">{result.note}</div>}
          {result.warnings.map((warning) => (
            <div key={warning} className="text-xs text-amber-700 dark:text-amber-400">⚠ {warning}</div>
          ))}
          {result.created.length > 0 && (
            <ul className="text-xs text-gray-600 dark:text-gray-300 space-y-0.5">
              {result.created.map((unit) => (
                <li key={unit.issueId}>
                  <span className="font-mono text-gray-400 dark:text-gray-500">#{unit.issueNumber ?? "?"}</span> {unit.title}
                  {(unit.artifacts?.length ?? 0) > 0 && (
                    <span className="ml-1">
                      {unit.artifacts!.map((path) => (
                        <button
                          key={path}
                          type="button"
                          onClick={() => { setOpenArtifact(path); setOpenArtifactStep(null); setArtifactFromGate(false); }}
                          className="text-[11px] font-mono text-brand-600 dark:text-brand-400 hover:underline ml-1"
                        >
                          📄 {path.split("/").pop()}
                        </button>
                      ))}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <LoopTimeline
        pluginId={loop.pluginId}
        loopName={loop.name}
        projectId={projectId}
        refreshKey={timelineKey}
        hasGate={!!loop.gate}
      />
      </div>

      {/* Inline artifact viewer (#288) — opened from the gate card, stepper, or unit list.
          At `lg` with the pane in split mode this is the LEFT column (#447); stacked below
          that, and a full-screen sheet below `sm` (#434). */}
      {openArtifact && (
        <ArtifactViewer
          pluginId={loop.pluginId}
          loopName={loop.name}
          projectId={projectId}
          path={openArtifact}
          step={openArtifactStep ?? undefined}
          /* #457 — label-driven bookkeeping detection (#454). With the gate's own action
             labels the viewer folds away a file-backed gate's `[ ] Approved / [ ] Needs
             revision` machinery even when the plugin heads that section its own way; without
             them it falls back to the generic approval vocabulary. */
          gateActionLabels={loop.gate?.actions.map((a) => a.label)}
          /* #457/#452 — the identifiers the failing checks quote, as one-click jump chips,
             and (from a gate-card open) the first FAILED check's token as the opening search
             so the viewer lands on the row the check names instead of the top of the file. */
          findHints={findHints}
          initialFind={artifactFromGate ? initialFind : undefined}
          onOpenArtifact={setOpenArtifact}
          onClose={() => { setOpenArtifact(null); setOpenArtifactStep(null); setArtifactFromGate(false); }}
          onLineNotesChange={setLineNotes}
        />
      )}
    </div>
  );
}

/** One-shot deterministic subprocess. */
/**
 * Last run per script, surviving a pane switch (#414).
 *
 * The result used to live in the pane's own state, so selecting another script threw it
 * away — and with no timestamp anywhere, "did I already run this?" had no answer short of
 * running it again. Module-scoped rather than persisted: a script's output is about the
 * repo as it was minutes ago, so carrying it across a page reload would be a lie, while
 * carrying it across a pane switch is exactly what the reader expects.
 */
const lastScriptRuns = new Map<string, { result: ScriptRunResult; ranAt: number }>();

export function PluginScriptPane({ script, projectId }: { script: PluginScript; projectId: string }) {
  const runKey = `${script.pluginId}:${script.name}:${projectId}`;
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState(() => lastScriptRuns.get(runKey) ?? null);
  // Selecting a different script re-renders this same component with new props.
  useEffect(() => { setLastRun(lastScriptRuns.get(runKey) ?? null); }, [runKey]);
  const result = lastRun?.result ?? null;

  async function run() {
    if (running) return;
    setRunning(true);
    try {
      const res = await apiPost<ScriptRunResult>(
        `/api/plugins/${script.pluginId}/scripts/${encodeURIComponent(script.name)}/run`,
        { projectId },
      );
      const entry = { result: res, ranAt: Date.now() };
      lastScriptRuns.set(runKey, entry);
      setLastRun(entry);
      if (res.timedOut) showToast(`"${script.label}" timed out`, "error");
      else if (res.code !== 0) showToast(`"${script.label}" exited ${res.code}`, "error");
      else showToast(`"${script.label}" finished`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Script run failed", "error");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="p-3 sm:p-6 space-y-4 min-h-0 flex flex-col" data-testid="plugin-script-pane">
      <PaneHeading title={script.label} subtitle={script.description} />
      <div className="flex items-center gap-2">
        <code className="text-[11px] px-2 py-1 rounded bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-300 truncate flex-1">
          {script.command}
        </code>
        <button
          onClick={() => void run()}
          disabled={running}
          className="text-sm px-4 py-2.5 sm:px-3 sm:py-1.5 min-h-11 sm:min-h-0 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 shrink-0"
          data-testid="plugin-script-run"
        >
          {running ? "Running…" : "Run"}
        </button>
      </div>
      {result && (
        <div className="flex-1 min-h-0 flex flex-col gap-1">
          <div className="text-xs text-gray-500 dark:text-gray-400" data-testid="plugin-script-result-meta">
            {result.timedOut ? "Timed out" : `Exit code ${result.code ?? "?"}`}
            {result.code === 0 && !result.timedOut ? " ✓" : ""}
            {lastRun && ` · ran ${formatRelativeTime(new Date(lastRun.ranAt).toISOString())}`}
          </div>
          <pre className="flex-1 min-h-0 p-3 rounded bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 overflow-auto whitespace-pre-wrap break-all text-[11px] text-gray-700 dark:text-gray-300">
            {[
              result.stdout && `── stdout ──\n${result.stdout}`,
              result.stderr && `── stderr ──\n${result.stderr}`,
            ].filter(Boolean).join("\n\n") || "(no output)"}
          </pre>
        </div>
      )}
    </div>
  );
}

