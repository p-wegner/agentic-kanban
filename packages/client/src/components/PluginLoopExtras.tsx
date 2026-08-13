import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { DiffComment, CreateDiffCommentRequest } from "@agentic-kanban/shared";
import { apiFetch, apiPost, apiPut } from "../lib/api.js";
import { showToast } from "./Toast.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { DiffViewer } from "./DiffViewer.js";
import {
  canSubmitGateAction,
  gateActionButtonClasses,
  gateActionIntent,
  gateActionTitle,
  gateFeedbackText,
  gateInputPlaceholder,
  gateInputRequirementHint,
  gateRecommendationConflict,
  partitionGateChecks,
  viewGateRecommendation,
} from "./gateCardPolicy.js";

/**
 * The loop pane's structured extras (#286–#294): approval gate card, pipeline
 * stepper, check badges, artifact viewer, and the audit timeline. Split out of
 * PluginActionPanes so that file stays under the god-module ceiling and each
 * concern here is independently testable.
 */

export type PluginGateAction = { id: string; label: string; input?: "text" };
export type PluginGate = {
  id: string;
  question: string;
  artifacts?: string[];
  actions: PluginGateAction[];
};
export type PluginProgressStep = {
  id: string;
  label: string;
  state: "done" | "generating" | "awaiting-approval" | "needs-revision" | "locked" | "failed" | "pending";
  version?: string;
  artifacts?: string[];
};
export type PluginCheck = { name: string; verdict: "pass" | "warn" | "fail"; detail?: string };
export type StartPolicy = { mode: string; autoStartUnblocked: boolean } | null;

/**
 * The loop's "work exists but nothing landed it" state (#299/#336/#363).
 *
 * `mergeSafe` is load-bearing, not decoration: on #363's live stall the parked branch had ZERO
 * commits, so a one-click Merge would have closed the unit without its artifacts. Read it before
 * offering the button.
 */
export type LoopStall = {
  workspaceId: string;
  issueNumber: number | null;
  issueTitle: string;
  reason?: "builder-finished-unmerged" | "workspace-parked-issue-unfinished" | "unit-already-landed";
  mergeSafe?: boolean;
  detail?: string;
  since?: string;
  contradictoryReadyFlag?: boolean;
};

// ── State chips (#293) ────────────────────────────────────────────────

/** Why the loop planned nothing — four look-alike states, told apart explicitly. */
export function LoopStateChips({ loop, startPolicy, onSwitchToMonitor, switchingMode = false }: {
  loop: {
    paused: boolean; converged: boolean; openTickets: number;
    gate: PluginGate | null; note: string | null; closedTickets: number;
    awaitingMerge?: LoopStall | null;
  };
  startPolicy: StartPolicy;
  /**
   * One-click fix for the manual-Start-Mode chip (#428). The chip is the PERSISTENT statement
   * of the problem — the advance result carries the same warning but only on the advance that
   * actually creates tickets, so it is gone the moment you navigate away while the loop stays
   * stuck. The remedy belongs next to the durable signal, not the transient one.
   */
  onSwitchToMonitor?: () => void;
  switchingMode?: boolean;
}) {
  const chips: Array<{ text: string; tone: "gray" | "amber" | "green" | "blue" | "red" }> = [];
  if (loop.paused) chips.push({ text: "Paused", tone: "amber" });
  // #363: two different stalls reach this field now, and calling the parked one "step done"
  // is the misreport the ticket was filed for — that workspace's ticket never finished and its
  // branch may hold nothing at all.
  if (loop.awaitingMerge) {
    // #337: three states reach this field. Calling an ALREADY-LANDED leftover "waiting for merge"
    // is the misreport that ticket was filed for — the operator docs map that wording to "click
    // Merge now", which on already-merged work is the wrong action.
    chips.push(loop.awaitingMerge.reason === "unit-already-landed"
      ? { text: "Step landed — leftover workspace closing", tone: "gray" }
      : loop.awaitingMerge.mergeSafe === false
        ? { text: "Step parked — ticket never finished", tone: "red" }
        : { text: "Step done — waiting for merge", tone: "amber" });
  }
  else if (loop.openTickets > 0) chips.push({ text: "Round running", tone: "blue" });
  else if (loop.converged) chips.push({ text: "Converged", tone: "green" });
  else if (loop.gate) chips.push({ text: "Waiting on you", tone: "amber" });
  else if (loop.note && loop.closedTickets + loop.openTickets > 0) chips.push({ text: "Waiting on input", tone: "amber" });
  // The worst trap: under manual start mode the monitor never runs the planner, which is
  // indistinguishable from convergence unless somebody says so.
  if (startPolicy && startPolicy.mode === "manual" && !loop.converged) {
    chips.push({ text: "Start mode is Manual — the monitor will not drive this loop", tone: "red" });
  }
  if (chips.length === 0) return null;
  const toneClass = {
    gray: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    green: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    blue: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    red: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  } as const;
  const manualChip = startPolicy?.mode === "manual" && !loop.converged;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="plugin-loop-state-chips">
      {chips.map((chip) => (
        <span key={chip.text} className={`text-[11px] px-2 py-0.5 rounded ${toneClass[chip.tone]}`}>
          {chip.text}
        </span>
      ))}
      {manualChip && onSwitchToMonitor && (
        <button
          type="button"
          onClick={onSwitchToMonitor}
          disabled={switchingMode}
          data-testid="plugin-loop-switch-start-mode"
          title="Set this project's Start Mode to monitor so the board starts this loop's tickets"
          className="text-[11px] px-2 py-0.5 rounded border border-red-300 dark:border-red-700 text-red-800 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-50"
        >
          {switchingMode ? "Switching…" : "Switch to monitor"}
        </button>
      )}
    </div>
  );
}

// ── Check badges (#290) ───────────────────────────────────────────────

export function ChecksBadges({ checks }: { checks: PluginCheck[] | null }) {
  if (!checks || checks.length === 0) return null;
  const tone = {
    pass: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    warn: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    fail: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  } as const;
  const mark = { pass: "✓", warn: "⚠", fail: "✕" } as const;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="plugin-loop-checks">
      {checks.map((check) => (
        <span
          key={check.name}
          title={check.detail ?? check.name}
          className={`text-[11px] px-2 py-0.5 rounded cursor-default ${tone[check.verdict]}`}
        >
          {mark[check.verdict]} {check.name}
        </span>
      ))}
    </div>
  );
}

// ── Pipeline stepper (#289) ───────────────────────────────────────────

const STEP_MARK: Record<PluginProgressStep["state"], string> = {
  "done": "✓",
  "generating": "⟳",
  "awaiting-approval": "👁",
  "needs-revision": "✎",
  "locked": "·",
  "failed": "✕",
  "pending": "·",
};

const STEP_TONE: Record<PluginProgressStep["state"], string> = {
  "done": "border-green-300 dark:border-green-800 text-green-800 dark:text-green-300 bg-green-50 dark:bg-green-900/20",
  "generating": "border-blue-300 dark:border-blue-800 text-blue-800 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/20",
  "awaiting-approval": "border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20",
  "needs-revision": "border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20",
  "locked": "border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 bg-transparent",
  "failed": "border-red-300 dark:border-red-800 text-red-800 dark:text-red-300 bg-red-50 dark:bg-red-900/20",
  "pending": "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 bg-transparent",
};

export function ProgressStepper({ steps, activePath, onOpenStep }: {
  steps: PluginProgressStep[] | undefined;
  /** Path currently open in the viewer — keeps its chip visibly selected (#423). */
  activePath?: string | null;
  /** Reports the whole step, not just a path, so the viewer can show step context
   *  and offer the step's OTHER artifacts (#422). */
  onOpenStep: (step: PluginProgressStep, index: number, total: number) => void;
}) {
  if (!steps || steps.length === 0) return null;
  return (
    <ol className="flex flex-wrap items-center gap-1" data-testid="plugin-loop-stepper">
      {steps.map((step, i) => {
        const count = step.artifacts?.length ?? 0;
        const clickable = count > 0;
        const isActive = !!activePath && (step.artifacts ?? []).includes(activePath);
        return (
          <li key={step.id} className="flex items-center gap-1">
            {i > 0 && <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>}
            <button
              type="button"
              disabled={!clickable}
              aria-current={isActive ? "true" : undefined}
              onClick={() => clickable && onOpenStep(step, i + 1, steps.length)}
              title={`${step.label} — ${step.state}${step.version ? ` (${step.version})` : ""}${
                clickable
                  ? `\nClick to open ${count === 1 ? "the artifact" : `its ${count} artifacts`}`
                  : ""
              }`}
              className={`text-[11px] px-2 py-1 rounded border ${STEP_TONE[step.state]} ${clickable ? "hover:underline cursor-pointer" : "cursor-default"} ${isActive ? "ring-2 ring-brand-400 ring-offset-1 dark:ring-offset-gray-900" : ""}`}
            >
              <span aria-hidden="true">{STEP_MARK[step.state]}</span> {step.label}
              {step.version && <span className="opacity-70"> {step.version}</span>}
              {/* A step with several outputs used to look identical to one with a single
                  output, while silently opening only the first (#422). */}
              {count > 1 && (
                <span className="ml-1 opacity-70" title={`${count} artifacts`}>📄{count}</span>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// ── Awaiting-merge card (#299) ───────────────────────────────────────

/**
 * The loop's silent-stall state, made loud: the step's agent finished but the
 * workspace never landed, so the planner (reading the MAIN checkout) is blind
 * and every advance is a dedupe no-op. One click triggers the board merge; the
 * merge-to-advance hook (#298) then surfaces the gate on its own.
 *
 * #363 added a SECOND stall to the same field — a workspace parked `ready_for_merge` whose
 * issue never left In Progress — and it must NOT get the merge button. The live instance's
 * branch had zero commits; merging it would close the unit without its artifacts and deadlock
 * the loop, which is the outcome `exit-workflow.ts` already refuses by name. So when
 * `mergeSafe === false` this card reports and links, and does not offer to land anything.
 */
export function AwaitingMergeCard({ awaitingMerge, onMergeStarted }: {
  awaitingMerge: LoopStall;
  onMergeStarted: () => void;
}) {
  const [merging, setMerging] = useState(false);
  async function merge() {
    if (merging) return;
    setMerging(true);
    try {
      await apiPost(`/api/workspaces/${awaitingMerge.workspaceId}/merge?async=1`, {});
      showToast("Merge started — the loop advances automatically once it lands", "success");
      // Give the async merge a moment to land before the surface refetch.
      setTimeout(onMergeStarted, 8000);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Merge failed to start", "error");
      setMerging(false);
    }
  }
  // #337 — an already-landed leftover is neither "parked" (nothing is wrong) nor mergeable
  // (the work is already on the base branch). It gets its own, calm copy: the previous wording
  // told the operator to click Merge now on a step whose merge commit was already on master.
  const landed = awaitingMerge.reason === "unit-already-landed";
  const parked = !landed && awaitingMerge.mergeSafe === false;
  const ref = awaitingMerge.issueNumber != null ? `#${awaitingMerge.issueNumber} ` : "";
  return (
    <div
      className={parked
        ? "rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3 max-w-2xl flex items-center gap-3"
        : landed
          ? "rounded border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-3 max-w-2xl flex items-center gap-3"
          : "rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 max-w-2xl flex items-center gap-3"}
      data-testid="plugin-loop-awaiting-merge"
      data-stall-reason={awaitingMerge.reason ?? "builder-finished-unmerged"}
    >
      <div className={parked
        ? "flex-1 text-xs text-red-900 dark:text-red-200"
        : landed
          ? "flex-1 text-xs text-gray-700 dark:text-gray-300"
          : "flex-1 text-xs text-amber-900 dark:text-amber-200"}>
        <span className="font-medium">
          {parked
            ? "Step parked, ticket never finished:"
            : landed
              ? "Step already landed — nothing to merge:"
              : "Step finished but not landed:"}
        </span>{" "}
        {ref}{awaitingMerge.issueTitle}.
        {" "}{awaitingMerge.detail ?? "Until the merge lands, the planner cannot see the artifacts."}
        {awaitingMerge.contradictoryReadyFlag && (
          <>{" "}<span className="font-medium">
            The workspace also reports ready_for_merge and readyForMerge=false at the same time — treat both as unreliable.
          </span></>
        )}
      </div>
      {parked ? (
        <a
          href={`/workspaces/${awaitingMerge.workspaceId}`}
          className="text-sm px-3 py-1.5 rounded border border-red-400 dark:border-red-600 text-red-800 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900/40 shrink-0"
          data-testid="plugin-loop-inspect-stall"
        >
          Inspect workspace
        </a>
      ) : landed ? (
        <a
          href={`/workspaces/${awaitingMerge.workspaceId}`}
          className="text-sm px-3 py-1.5 rounded border border-gray-400 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 shrink-0"
          data-testid="plugin-loop-inspect-stall"
        >
          Inspect workspace
        </a>
      ) : (
        <button
          onClick={() => void merge()}
          disabled={merging}
          className="text-sm px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 shrink-0"
          data-testid="plugin-loop-merge-now"
        >
          {merging ? "Merging…" : "Merge now"}
        </button>
      )}
    </div>
  );
}

// ── Approval gate card (#286) ─────────────────────────────────────────

type GateResolveResponse = {
  gateId: string;
  actionId: string;
  resolve: { code: number | null; stdout: string; stderr: string; timedOut: boolean };
  advance: { note: string | null; created: Array<{ issueNumber: number | null; title: string }> } | null;
};

/** Compact age for the gate badge — minutes under an hour, then hours, then days. */
function formatGateAge(since: string): string {
  const ms = Date.now() - new Date(since).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "an unknown time";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ${min % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function normalizeForCompare(text: string): string {
  return text.replace(/[\s`"'“”]+/g, " ").trim().toLowerCase();
}

/**
 * A gate question often carries BOTH the decision and a truncated copy of the failure that
 * caused it — e.g. `Approve step 7/9 — Test & QA (v3)? ⚠ 1 record row(s) claim verification
 * for a criterion the Findings declare unverifiable: STORY-3-1 Sz.1 is recorded manual while
 * Finding F1 says "cannot be verif".` The full, untruncated version of that same sentence is
 * ALREADY rendered right below as the failing check's detail, so the card said it twice — and
 * the second copy was the readable one. The duplication pushed the butler's verdict and the
 * action buttons below the fold, which is the actual cost: the reader scrolls past a repeated
 * paragraph to reach the decision.
 *
 * So split the question at its first `?` and drop the trailing detail *only when a check
 * already says it*. Plugin-agnostic by construction: it never parses the plugin's format, it
 * just refuses to print the same sentence twice. A question with no trailing detail, or whose
 * detail appears in no check, is rendered exactly as before.
 *
 * ── The two-tail bug (#449, MEASURED) ──
 *
 * The first version probed the WHOLE tail against each check detail. A question may carry more
 * than one appended `⚠` segment — the live `mealplan` step-7 gate carried two ("8 of 50 …
 * UNEXECUTED" and a classification sentence). Their concatenation matches no single check, so
 * the dedupe silently declined and the card printed the finding a second time. It failed toward
 * "print it twice", which is exactly the state this function exists to prevent, and it did so
 * invisibly.
 *
 * So the tail is split on its `⚠` markers and each segment is judged on its own: echoed
 * segments are dropped, the rest are returned in `keptDetails` for the card to render as
 * findings in their own right (rather than as a run-on heading). When NOTHING is echoed the
 * question is returned verbatim, so a plugin whose question we cannot read is never reflowed.
 */
export function splitGateQuestion(
  question: string,
  checks?: Array<{ detail?: string | null }> | null,
): { heading: string; duplicatedDetail: string | null; keptDetails: string[] } {
  const boundary = question.indexOf("?");
  if (boundary === -1 || boundary === question.length - 1) {
    return { heading: question, duplicatedDetail: null, keptDetails: [] };
  }
  const heading = question.slice(0, boundary + 1);
  const segments = question
    .slice(boundary + 1)
    .split("⚠")
    .map((segment) => segment.replace(/^[\s!*-]+/, "").trim())
    .filter(Boolean);
  if (segments.length === 0) return { heading, duplicatedDetail: null, keptDetails: [] };

  // Each segment is a TRUNCATION of its check's detail, so compare a prefix rather than the
  // whole string. Long enough not to collide by accident, short enough to survive truncation.
  const echoed: string[] = [];
  const kept: string[] = [];
  for (const segment of segments) {
    const probe = normalizeForCompare(segment).slice(0, 40);
    const isEchoed = probe.length >= 20 && (checks ?? []).some((check) =>
      check.detail ? normalizeForCompare(check.detail).includes(probe) : false);
    (isEchoed ? echoed : kept).push(segment);
  }
  if (echoed.length === 0) return { heading: question, duplicatedDetail: null, keptDetails: [] };
  return { heading, duplicatedDetail: echoed.join(" "), keptDetails: kept };
}

export function GateCard({ pluginId, loopName, projectId, gate, gateSince, checks, recommendation, lineNotes, onResolved, onOpenArtifact }: {
  pluginId: string;
  loopName: string;
  projectId: string;
  gate: PluginGate;
  /** When this gate was first reached — drives the "waiting Xm" badge. */
  gateSince?: string | null;
  /** Verification checks rendered EXPANDED on the card (#303) — the human should read the verdict without opening anything. */
  checks?: PluginCheck[] | null;
  /** The butler's pre-read verdict (#309). */
  recommendation?: { actionId: string; reason: string } | null;
  /** Line-anchored notes collected on the artifact diff (#304); appended to revise feedback. */
  lineNotes?: string[];
  onResolved: () => void;
  onOpenArtifact: (path: string) => void;
}) {
  const [selected, setSelected] = useState<PluginGateAction | null>(null);
  const [input, setInput] = useState("");
  const [resolving, setResolving] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [editing, setEditing] = useState<{ path: string; content: string; loading: boolean; saving: boolean } | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);

  // A fresh gate (new id) must not inherit the previous gate's half-typed feedback.
  useEffect(() => { setSelected(null); setInput(""); setEditing(null); setSummary(null); }, [gate.id]);

  async function act(action: PluginGateAction) {
    if (action.input === "text" && selected?.id !== action.id) {
      setSelected(action); // first click arms the textarea; the confirm button submits
      return;
    }
    const feedback = gateFeedbackText(input, lineNotes);
    if (!canSubmitGateAction(action, input, lineNotes)) {
      // Belt-and-braces: the Confirm button is disabled in this state (#378 B), so reaching
      // here means a programmatic call. Keep the toast rather than failing silently.
      showToast(gateInputRequirementHint(action), "error");
      return;
    }
    setResolving(true);
    try {
      const res = await apiPost<GateResolveResponse>(
        `/api/plugins/${pluginId}/loops/${encodeURIComponent(loopName)}/gate/resolve`,
        { projectId, gateId: gate.id, actionId: action.id, input: action.input === "text" ? feedback : undefined },
      );
      showToast(
        res.advance?.created.length
          ? `Decision applied — planned: ${res.advance.created.map((t) => `#${t.issueNumber ?? "?"}`).join(", ")}`
          : `Decision applied${res.advance?.note ? ` — ${res.advance.note}` : ""}`,
        "success",
      );
      onResolved();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Gate resolve failed", "error");
    } finally {
      setResolving(false);
    }
  }

  /** Draft-with-butler (#310): rough notes in the textarea → charter-aware feedback. */
  async function draftFeedback() {
    if (drafting) return;
    if (!input.trim()) {
      showToast("Type your rough thoughts first — the butler turns them into submit-ready feedback", "error");
      return;
    }
    setDrafting(true);
    try {
      const res = await apiPost<{ draft: string }>(
        `/api/plugins/${pluginId}/loops/${encodeURIComponent(loopName)}/gate/draft`,
        { projectId, gateId: gate.id, notes: input },
      );
      setInput(res.draft);
      showToast("Butler drafted the feedback — edit and confirm", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Draft failed", "error");
    } finally {
      setDrafting(false);
    }
  }

  /** Summarize-for-me (#330): one click → decision-ready butler digest, rendered on the card. */
  async function summarize() {
    if (summarizing) return;
    setSummarizing(true);
    try {
      const res = await apiPost<{ summary: string }>(
        `/api/plugins/${pluginId}/loops/${encodeURIComponent(loopName)}/gate/summarize`,
        { projectId, gateId: gate.id },
      );
      setSummary(res.summary);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Summary failed", "error");
    } finally {
      setSummarizing(false);
    }
  }

  /** Edit-then-approve (#305): open an artifact editable in place. */
  async function openEditor(path: string) {
    setEditing({ path, content: "", loading: true, saving: false });
    try {
      const res = await apiFetch<{ exists: boolean; content: string | null; truncated: boolean }>(
        `/api/plugins/${pluginId}/loops/${encodeURIComponent(loopName)}/artifact?projectId=${projectId}&path=${encodeURIComponent(path)}`,
      );
      if (!res.exists || res.content === null) throw new Error("Artifact not found");
      if (res.truncated) throw new Error("Artifact too large to edit inline — edit it in the repo");
      setEditing({ path, content: res.content, loading: false, saving: false });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to load artifact", "error");
      setEditing(null);
    }
  }

  async function saveEdit() {
    if (!editing || editing.saving) return;
    setEditing({ ...editing, saving: true });
    try {
      const res = await apiPut<{ path: string; committed: boolean }>(
        `/api/plugins/${pluginId}/loops/${encodeURIComponent(loopName)}/artifact`,
        { projectId, gateId: gate.id, path: editing.path, content: editing.content },
      );
      showToast(res.committed ? "Edit saved and committed — approve when ready" : "Edit saved (commit pending — index busy)", "success");
      setEditing(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Save failed", "error");
      setEditing({ ...editing, saving: false });
    }
  }

  // #378 A — validated at READ time against the currently-offered actions, not at
  // recommendation time (which is what `action-not-offered` already covers, #333).
  const recommendationView = viewGateRecommendation(gate, recommendation);

  const checkTone = {
    pass: "text-green-800 dark:text-green-300",
    warn: "text-amber-800 dark:text-amber-300",
    fail: "text-red-800 dark:text-red-300",
  } as const;
  const checkIcon = { pass: "✓", warn: "⚠", fail: "✕" } as const;

  const questionView = splitGateQuestion(gate.question, checks);
  // #449 — the card was ~500px of uniform amber prose in one type size, so "what stops me
  // approving" was the fifth paragraph. Split the checks: only fail/warn can withdraw a plain
  // approval, and those go first, one row each; passing checks and the gate age are reassurance
  // and collapse.
  const { blocking, passing } = partitionGateChecks(checks);
  const hasBlocking = blocking.length > 0 || questionView.keptDetails.length > 0;
  // #451 — a butler that recommends approving while a check FAILS is the most decision-relevant
  // fact on the card; it used to be left for the reader to spot across the two smallest elements.
  const recommendationConflict = gateRecommendationConflict(
    recommendationView?.actionable ? recommendationView.action : null,
    checks,
  );

  const blockingBlock = hasBlocking ? (
    <div
      className="rounded border border-red-300 dark:border-red-800 bg-white/70 dark:bg-gray-900/40 px-3 py-2 space-y-1.5"
      data-testid="plugin-gate-blocking"
    >
      <div className="text-[11px] font-semibold uppercase tracking-wide text-red-800 dark:text-red-300">
        What stops a plain approval
      </div>
      {/* Findings the question carries that NO check repeats (#449). They are real findings, so
          they belong in this block — not tacked onto the heading as run-on prose. */}
      {questionView.keptDetails.map((detail) => (
        <div key={detail} className="flex gap-1.5 text-xs text-amber-900 dark:text-amber-200">
          <span aria-hidden="true">⚠</span>
          <span className="flex-1">{detail}</span>
        </div>
      ))}
      {blocking.map((check) => (
        <div key={check.name} className={`flex gap-1.5 text-xs ${checkTone[check.verdict]}`}>
          <span aria-hidden="true">{checkIcon[check.verdict]}</span>
          <span className="flex-1">
            <span className="font-medium">{check.name}:</span> {check.detail ?? check.verdict.toUpperCase()}
          </span>
        </div>
      ))}
    </div>
  ) : null;

  const secondaryBlock = (passing.length > 0 || gateSince) ? (
    // Open by default when nothing blocks — then the passing checks ARE the story.
    <details className="text-xs" data-testid="plugin-gate-secondary" open={!hasBlocking}>
      <summary className="cursor-pointer select-none text-[11px] text-amber-800 dark:text-amber-300">
        {passing.length > 0 ? `${passing.length} check(s) passing` : "Gate context"}
        {gateSince ? ` · waiting ${formatGateAge(gateSince)}` : ""}
      </summary>
      <div className="mt-1 space-y-1">
        {/* How long this decision has been blocking the pipeline. Sourced from the gate's own
            `gate-reached` event, so a re-planned loop cannot make an old gate look fresh. */}
        {gateSince && (
          <div className="text-[11px] text-amber-800 dark:text-amber-300" data-testid="plugin-gate-age">
            Waiting {formatGateAge(gateSince)} · since {new Date(gateSince).toLocaleString("en-US")}
          </div>
        )}
        {passing.map((check) => (
          <div key={check.name} className={`flex gap-1.5 text-xs ${checkTone[check.verdict]}`}>
            <span aria-hidden="true">{checkIcon[check.verdict]}</span>
            <span className="flex-1">
              <span className="font-medium">{check.name}:</span> {check.detail ?? check.verdict.toUpperCase()}
            </span>
          </div>
        ))}
      </div>
    </details>
  ) : null;

  return (
    <div
      className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4 space-y-3 max-w-2xl"
      data-testid="plugin-gate-card"
    >
      {/* (a) The decision line — the one sentence the reader answers. */}
      <div className="text-base font-semibold text-amber-900 dark:text-amber-100" data-testid="plugin-gate-question">
        ✋ {questionView.heading}
      </div>
      {/* Butler recommendation (#309) — a pre-read, never a decision. Full-width block directly
          under the question (#451): it is the element that can save the reviewer the most work,
          and it used to be an 11px chip in a hairline box with a truncated action label.
          A recommendation whose action is no longer offered stays visible but loses its Accept
          button (#378 A): the chip was handing out a one-click path to an action the gate had
          deliberately withdrawn, and the click was silently inert. */}
      {recommendation && recommendationView && (
        <div
          className="rounded border border-amber-300 dark:border-amber-700 bg-white/70 dark:bg-gray-900/40 px-3 py-2 space-y-2"
          data-testid="plugin-gate-recommendation"
          data-recommendation-state={recommendationView.actionable ? "actionable" : recommendationView.skipReason}
        >
          <div className="flex items-start gap-2 text-xs">
            <span aria-hidden="true">🤵</span>
            <span className="flex-1 text-amber-900 dark:text-amber-200">
              Butler recommends <span className="font-medium">{recommendation.actionId}</span>
              {recommendation.reason ? ` — ${recommendation.reason}` : ""}
              {!recommendationView.actionable && (
                <span className="block mt-0.5 text-amber-800 dark:text-amber-300" data-testid="plugin-gate-recommendation-stale">
                  ⚠ That action is no longer offered on this gate — this is a pre-read only. Choose
                  one of the actions below.
                </span>
              )}
              {recommendationConflict && (
                <span
                  className="block mt-1 font-medium text-red-800 dark:text-red-300"
                  data-testid="plugin-gate-recommendation-conflict"
                >
                  ⚠ The butler disputes a failing check — it recommends approving while{" "}
                  {recommendationConflict.failing.map((c) => c.name).join(", ")} FAILED. One of the
                  two is wrong, and deciding which is the call you are being asked to make.
                </span>
              )}
            </span>
          </div>
          {recommendationView.actionable && (
            <button
              onClick={() => void act(recommendationView.action)}
              disabled={resolving}
              /* #451 — the label was `max-w-[12rem] truncate`, so a button that resolves the gate
                 by waiving 8 unexecuted acceptance criteria read "Do it: Approve, waiving unexec…".
                 #414 deliberately renamed it from "Accept" to name the consequence, and the width
                 cap then ate the consequence. It wraps now; the label is never cut. */
              className="w-full sm:w-auto text-left whitespace-normal break-words text-xs px-3 py-2.5 sm:py-1.5 min-h-11 sm:min-h-0 rounded border border-amber-400 dark:border-amber-600 hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-900 dark:text-amber-200 disabled:opacity-50"
              /* #414 — "Accept" alone did not say what it accepts. It is not "adopt this as
                 prefilled feedback": it RESOLVES the gate with that action, which on this very
                 gate means waiving 8 unexecuted acceptance criteria. Name the action it will
                 take, since that is the consequential half. */
              title={`Resolve this gate now by choosing "${recommendationView.action.label}". This is the butler's pre-read, not a verification.`}
              data-testid="plugin-gate-recommendation-accept"
            >
              Do it: {recommendationView.action.label}
            </button>
          )}
        </div>
      )}
      {/* (b) Verification digest (#303/#449) — blocking first, everything else collapsed. */}
      {(blockingBlock || secondaryBlock) && (
        <div className="space-y-2" data-testid="plugin-gate-checks-digest">
          {blockingBlock}
          {secondaryBlock}
        </div>
      )}
      {/* Summarize-for-me (#330) — butler digest rendered in place. */}
      {summary && (
        <div
          className="text-xs whitespace-pre-wrap rounded border border-amber-200 dark:border-amber-800 bg-white/60 dark:bg-gray-900/40 px-2.5 py-2 text-amber-900 dark:text-amber-200"
          data-testid="plugin-gate-summary"
        >
          {summary}
        </div>
      )}
      {/* Utility row (#450): the artifact chips and "Summarize for me" are things you do BEFORE
          deciding, so they belong together and away from the decision buttons. Summarize used to
          sit in the decision row at the same weight as the two opposite answers, making a third
          of that row a non-decision. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {(gate.artifacts ?? []).map((path) => (
            <span key={path} className="inline-flex items-stretch rounded border border-amber-300 dark:border-amber-700 overflow-hidden">
              <button
                type="button"
                onClick={() => onOpenArtifact(path)}
                className="text-[11px] font-mono px-3 py-2.5 sm:px-2 sm:py-0.5 min-h-11 sm:min-h-0 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                title="Open the artifact under review"
              >
                📄 {path.split("/").pop()}
              </button>
              {/* The pencil was a ~20x22px sliver glued to the open button inside one pill —
                  on a phone you open the EDITOR when you meant to read. Widened to a 44px
                  target below sm; unchanged on desktop where the dense pill is fine (#433). */}
              <button
                type="button"
                onClick={() => void openEditor(path)}
                className="text-[11px] px-3 py-2.5 sm:px-1.5 sm:py-0.5 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 border-l border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                title="Edit the artifact before approving (#305)"
                data-testid={`plugin-gate-edit-${path.split("/").pop()}`}
              >
                ✎
              </button>
            </span>
        ))}
        <button
          onClick={() => void summarize()}
          disabled={summarizing}
          className="text-[11px] px-3 py-2.5 sm:px-2 sm:py-0.5 min-h-11 sm:min-h-0 rounded border border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
          data-testid="plugin-gate-summarize"
          title="Butler reads the artifacts and posts a decision-ready digest here (#330)"
        >
          {summarizing ? "Summarizing…" : "🤵 Summarize for me"}
        </button>
      </div>
      {/* Edit-then-approve editor (#305). */}
      {editing && (
        <div className="space-y-2" data-testid="plugin-gate-editor">
          <div className="text-[11px] font-mono text-amber-900 dark:text-amber-200">{editing.path}</div>
          {editing.loading ? (
            <div className="text-xs text-gray-500">Loading…</div>
          ) : (
            <>
              <textarea
                value={editing.content}
                onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                rows={14}
                className="w-full text-xs font-mono px-2 py-1.5 rounded border border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-900"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void saveEdit()}
                  disabled={editing.saving}
                  className="text-xs px-2.5 py-1 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  {editing.saving ? "Saving…" : "Save & commit edit"}
                </button>
                <button
                  onClick={() => setEditing(null)}
                  className="text-xs px-2.5 py-1 rounded border border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {(lineNotes?.length ?? 0) > 0 && (
        <div className="text-[11px] text-amber-800 dark:text-amber-300" data-testid="plugin-gate-line-notes">
          {lineNotes!.length} line comment(s) from the diff will be attached to revision feedback.
        </div>
      )}
      {selected?.input === "text" && (
        <div className="space-y-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={4}
            autoFocus
            placeholder={gateInputPlaceholder(selected)}
            // text-base (16px) below sm is not cosmetic: iOS Safari ZOOMS the page on focus
            // for any input under 16px, and it does not zoom back out — leaving the gate
            // panned off-screen mid-answer. sm+ keeps the denser text-sm (#433).
            className="w-full text-base sm:text-sm px-2 py-2 sm:py-1.5 min-h-28 rounded border border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-900"
            data-testid="plugin-gate-input"
          />
          {/* #378 B — the Confirm button below is disabled until there is something to submit;
              say WHY, so a disabled button is never a puzzle either. */}
          {!canSubmitGateAction(selected, input, lineNotes) && (
            <div className="text-[11px] text-amber-800 dark:text-amber-300" data-testid="plugin-gate-input-required">
              {gateInputRequirementHint(selected)}
            </div>
          )}
          <button
            onClick={() => void draftFeedback()}
            disabled={drafting}
            className="text-[11px] px-2 py-0.5 rounded border border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
            data-testid="plugin-gate-draft"
            title="Send your rough notes to the butler; it returns submit-ready feedback (#310)"
          >
            {drafting ? "Drafting…" : "✨ Draft with butler"}
          </button>
        </div>
      )}
      {/* Wraps, and the buttons are full-width 44px targets below sm (#433): this row is
          THE thing you tap to answer a gate from a phone. It was a non-wrapping
          `flex items-center` of ~32px buttons whose longest label ("Confirm: Needs
          revision") cannot share a line with the others at any phone width. */}
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2">
        {gate.actions.map((action) => {
          // #450 — styled by SEMANTICS, not by `action.input === "text"`. At a QA gate both the
          // approve and the revise action require text, so the old rule rendered the two
          // opposite decisions identically and left the gate with no primary action at all.
          const intent = gateActionIntent(action);
          return (
            <button
              key={action.id}
              onClick={() => void act(action)}
              // #378 B — once the textarea is armed this button IS the confirm; a required-input
              // action with an empty box must not look clickable and then do nothing.
              disabled={resolving || (selected?.id === action.id && !canSubmitGateAction(action, input, lineNotes))}
              className={`text-sm px-4 py-2.5 sm:px-3 sm:py-1.5 min-h-11 sm:min-h-0 rounded disabled:opacity-50 disabled:cursor-not-allowed ${gateActionButtonClasses(intent)}`}
              title={gateActionTitle(action)}
              data-action-intent={intent}
              data-testid={`plugin-gate-action-${action.id}`}
            >
              {resolving ? "Applying…" : selected?.id === action.id && action.input === "text" ? `Confirm: ${action.label}` : action.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Artifact viewer (#288) ────────────────────────────────────────────

// ── Markdown navigation primitives (#452) ───────────────────────────
//
// A failing check quotes an exact identifier ("STORY-2-1 Sz.3 is recorded `auto` …") and the
// reviewer then has to find that row by eye in a 50-row table, inside a 60vh nested scroller
// where the browser's own Ctrl+F is close to useless. These three pure functions are what the
// viewer needs to answer "where is that": an outline to jump by structure, and a find that
// reports the matching LINES so the raw view can highlight and scroll to them.

export type MarkdownHeading = { depth: number; text: string; line: number; slug: string };

/**
 * CRLF-safe line split. Artifacts are read off a Windows checkout, so a plain `split("\n")`
 * leaves a trailing `\r` on every line — which made every "blank" line a `"\r"` line that
 * `pre-wrap` renders as 0px, silently eating the file's paragraph structure in the raw view.
 */
function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[`*_~]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

const FENCE_RE = /^\s{0,3}(```|~~~)/;

/** Headings of a markdown document, with their 0-based line numbers. Fenced code is skipped
 *  so a `# comment` inside a shell block never becomes a fake outline entry. */
export function parseMarkdownOutline(content: string): MarkdownHeading[] {
  const out: MarkdownHeading[] = [];
  let inFence = false;
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = m[2].trim();
    if (!text) continue;
    out.push({ depth: m[1].length, text, line: i, slug: slugifyHeading(text) });
  }
  return out;
}

/** 0-based indices of the lines containing `query` (case-insensitive, literal — the tokens
 *  a check quotes are identifiers like `STORY-2-1`, never regexes). */
export function findMatchingLines(content: string, query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: number[] = [];
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(needle)) hits.push(i);
  }
  return hits;
}

/** One line split into matched / unmatched runs, for `<mark>`ing without a regex. */
export function splitHighlight(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [{ text, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  const hay = text.toLowerCase();
  let at = 0;
  for (;;) {
    const idx = hay.indexOf(needle, at);
    if (idx === -1) break;
    if (idx > at) parts.push({ text: text.slice(at, idx), hit: false });
    parts.push({ text: text.slice(idx, idx + needle.length), hit: true });
    at = idx + needle.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts.length > 0 ? parts : [{ text, hit: false }];
}

// ── Plugin gate bookkeeping (#454) ──────────────────────────────────
//
// A file-backed gate keeps its answer IN the artifact: pm-pipeline's `status.md` opens with
//
//   ## Approval
//   - [ ] Approved
//   - [ ] Needs revision
//   ## Feedback
//   (reviewer writes here)
//
// Rendered verbatim, that is a second, non-functional approval form sitting directly above the
// real buttons — and hand-ticking it is explicitly forbidden (the plugin's own resolve script
// owns that file). So the viewer collapses it behind a disclosure that says what it is and who
// answers it.
//
// The detection is deliberately structural, never plugin-specific: a heading whose body is
// NOTHING BUT task-list items, whose labels mirror the gate's own action labels. When no action
// labels are supplied it falls back to a generic approval vocabulary on the heading. Anything
// that does not match is rendered unchanged — the failure mode is "show it", never "hide
// something we did not understand".

export type GateBookkeepingItem = { label: string; checked: boolean };
export type GateBookkeepingBlock = {
  /** 0-based inclusive line range covered, including an adjoining placeholder Feedback section. */
  startLine: number;
  endLine: number;
  heading: string;
  items: GateBookkeepingItem[];
  /** True once the file itself carries an answer — then it is a record, not a prompt. */
  answered: boolean;
  /** Set when a `## Feedback` placeholder section was folded in with the approval section. */
  feedbackHeading?: string;
};

const TASK_ITEM_RE = /^\s*[-*+]\s+\[([ xX])\]\s+(.*\S)\s*$/;
const GENERIC_APPROVAL_HEADING = /^(approval|approvals|sign[- ]?off|decision|review decision|gate)\b/i;

function normalizeLabel(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** "Approved" mirrors the gate action "Approve"; "Needs revision" mirrors "Needs revision". */
function labelsMirror(a: string, b: string): boolean {
  const x = normalizeLabel(a);
  const y = normalizeLabel(b);
  if (x.length < 4 || y.length < 4) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

export function detectGateBookkeeping(
  content: string,
  actionLabels?: string[] | null,
): GateBookkeepingBlock[] {
  const lines = splitLines(content);
  const headings = parseMarkdownOutline(content);
  if (headings.length === 0) return [];
  const sectionEnd = (i: number) => (i + 1 < headings.length ? headings[i + 1].line - 1 : lines.length - 1);

  const blocks: GateBookkeepingBlock[] = [];
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const end = sectionEnd(i);
    const body = lines.slice(heading.line + 1, end + 1);
    const items: GateBookkeepingItem[] = [];
    let foreign = 0;
    for (const line of body) {
      if (!line.trim()) continue;
      const m = TASK_ITEM_RE.exec(line);
      if (m) items.push({ label: m[2].trim(), checked: m[1].toLowerCase() === "x" });
      else foreign++;
    }
    if (items.length < 2 || foreign > 0) continue;

    const labels = (actionLabels ?? []).filter(Boolean);
    const mirrored = labels.length > 0
      ? items.filter((item) => labels.some((label) => labelsMirror(item.label, label))).length
      : 0;
    const qualifies = labels.length > 0
      ? mirrored * 2 >= items.length
      : GENERIC_APPROVAL_HEADING.test(heading.text);
    if (!qualifies) continue;

    const block: GateBookkeepingBlock = {
      startLine: heading.line,
      endLine: end,
      heading: heading.text,
      items,
      answered: items.some((item) => item.checked),
    };

    // The "(reviewer writes here)" prompt belongs to the same machinery — the board collects
    // that feedback in a textarea — but only fold it in when it really is a placeholder.
    const next = headings[i + 1];
    if (next && /^feedback\b/i.test(next.text)) {
      const nextEnd = sectionEnd(i + 1);
      const nextBody = lines.slice(next.line + 1, nextEnd + 1).filter((l) => l.trim());
      const placeholder = nextBody.length === 0
        || (nextBody.length === 1 && /^\(.*\)$/.test(nextBody[0].trim()));
      if (placeholder) {
        block.endLine = nextEnd;
        block.feedbackHeading = next.text;
        i++;
      }
    }
    blocks.push(block);
  }
  return blocks;
}

/** The document split into plain-markdown runs and collapsible bookkeeping runs. */
export type ArtifactSegment =
  | { kind: "markdown"; text: string }
  | { kind: "bookkeeping"; text: string; block: GateBookkeepingBlock };

export function segmentArtifact(content: string, blocks: GateBookkeepingBlock[]): ArtifactSegment[] {
  if (blocks.length === 0) return [{ kind: "markdown", text: content }];
  const lines = splitLines(content);
  const segments: ArtifactSegment[] = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.startLine > cursor) {
      segments.push({ kind: "markdown", text: lines.slice(cursor, block.startLine).join("\n") });
    }
    segments.push({ kind: "bookkeeping", text: lines.slice(block.startLine, block.endLine + 1).join("\n"), block });
    cursor = block.endLine + 1;
  }
  if (cursor < lines.length) segments.push({ kind: "markdown", text: lines.slice(cursor).join("\n") });
  return segments.filter((s) => s.kind === "bookkeeping" || s.text.trim().length > 0);
}

/** Flatten a ReactMarkdown heading's children back to text so it can carry a stable anchor id. */
function reactNodeText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join("");
  if (typeof node === "object" && "props" in (node as Record<string, unknown>)) {
    return reactNodeText((node as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

type ArtifactResponse = {
  path: string;
  exists: boolean;
  content: string | null;
  truncated: boolean;
  commits: Array<{ sha: string; date: string }>;
  diff: string | null;
  /** Whether a v(N-1)→vN diff can be fetched (#421) — the diff itself is deferred. */
  hasPreviousVersion?: boolean;
};

export function ArtifactViewer({ pluginId, loopName, projectId, path, step, gateActionLabels, findHints, initialFind, onOpenArtifact, onClose, onLineNotesChange }: {
  pluginId: string;
  loopName: string;
  projectId: string;
  path: string;
  /**
   * The step this artifact belongs to, when it was opened from the stepper (#422/#423).
   * Supplies the human-readable header ("Step 7/9 — Test & QA · v3") and, when the step
   * declares more than one artifact, the sibling picker. Absent when the viewer is opened
   * from the gate card or the unit list, which have their own per-file affordances.
   */
  step?: { label: string; version?: string; artifacts?: string[]; index?: number; total?: number };
  /**
   * The gate's own action labels (#454). Supplied, the viewer can tell a file-backed gate's
   * `[ ] Approved / [ ] Needs revision` machinery apart from ordinary checklist content and
   * collapse it. Omitted, detection falls back to a generic approval heading vocabulary — and
   * when neither matches, the file renders exactly as before.
   */
  gateActionLabels?: string[];
  /**
   * Identifiers a failing check quoted (#452) — offered as one-click "jump to" chips. The
   * caller extracts them with `checkLocationTokens` from `gateCardPolicy`.
   */
  findHints?: string[];
  /** Open the viewer already searching for this token, scrolled to the first hit (#452). */
  initialFind?: string;
  /** Switch to a sibling artifact of the same step without closing the viewer. */
  onOpenArtifact?: (path: string) => void;
  onClose: () => void;
  /**
   * Line-anchored review notes (#304): comments created on the version diff are
   * reported upward as "file:line: body" strings so the gate card can attach them
   * to revision feedback. Local-only — nothing is persisted server-side.
   */
  onLineNotesChange?: (notes: string[]) => void;
}) {
  const [artifact, setArtifact] = useState<ArtifactResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"rendered" | "raw" | "diff">("rendered");
  const [diffComments, setDiffComments] = useState<DiffComment[]>([]);
  // Find-in-document (#452). It operates on the RAW lines, which is the only representation
  // whose positions we can address: the rendered tree is arbitrary markdown output with no
  // line identity. So typing a query moves the viewer to the raw line view and highlights
  // there; the outline works in both tabs (rendered headings carry anchor ids).
  const [query, setQuery] = useState(initialFind ?? "");
  const [matchIndex, setMatchIndex] = useState(0);

  function publishNotes(comments: DiffComment[]) {
    onLineNotesChange?.(comments
      .filter((c) => !c.resolvedAt)
      .map((c) => `${c.filePath}:${c.lineNumNew ?? c.lineNumOld ?? "?"}: ${c.body}`));
  }

  function handleCreateComment(data: CreateDiffCommentRequest) {
    const now = new Date().toISOString();
    const next: DiffComment[] = [...diffComments, {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      workspaceId: "",
      filePath: data.filePath,
      lineNumOld: data.lineNumOld ?? null,
      lineNumNew: data.lineNumNew ?? null,
      side: data.side,
      body: data.body,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    }];
    setDiffComments(next);
    publishNotes(next);
  }

  function handleEditComment(commentId: string, body: string) {
    const next = diffComments.map((c) => (c.id === commentId ? { ...c, body, updatedAt: new Date().toISOString() } : c));
    setDiffComments(next);
    publishNotes(next);
  }

  function handleDeleteComment(commentId: string) {
    const next = diffComments.filter((c) => c.id !== commentId);
    setDiffComments(next);
    publishNotes(next);
  }

  function handleResolveComment(commentId: string, resolved: boolean) {
    const next = diffComments.map((c) => (c.id === commentId ? { ...c, resolvedAt: resolved ? new Date().toISOString() : null } : c));
    setDiffComments(next);
    publishNotes(next);
  }

  const diffStats = useMemo(() => {
    const diff = artifact?.diff ?? "";
    let insertions = 0;
    let deletions = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    return { filesChanged: 1, insertions, deletions };
  }, [artifact?.diff]);

  // The diff is fetched lazily (#421): opening an artifact costs one `git log`, and the
  // second `git` spawn only happens if the reader actually asks for the Diff tab.
  const [wantDiff, setWantDiff] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setArtifact(null);
    setError(null);
    setTab(initialFind ? "raw" : "rendered");
    setWantDiff(false);
    setQuery(initialFind ?? "");
    setMatchIndex(0);
    return () => { cancelled = true; void cancelled; };
  }, [pluginId, loopName, projectId, path, initialFind]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ArtifactResponse>(
      `/api/plugins/${pluginId}/loops/${encodeURIComponent(loopName)}/artifact`
      + `?projectId=${projectId}&path=${encodeURIComponent(path)}${wantDiff ? "&withDiff=1" : ""}`,
    )
      .then((res) => { if (!cancelled) setArtifact(res); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [pluginId, loopName, projectId, path, wantDiff]);

  /** Offering the Diff tab must not depend on the diff being loaded — that is the deferral. */
  const canDiff = artifact?.hasPreviousVersion ?? artifact?.diff != null;
  const diffPending = tab === "diff" && artifact?.diff == null;

  function openDiff() {
    setTab("diff");
    setWantDiff(true);
  }

  const siblings = step?.artifacts ?? [];

  const isMarkdown = /\.(md|markdown)$/i.test(path);

  const content = artifact?.content ?? "";
  const outline = useMemo(
    () => (isMarkdown && content ? parseMarkdownOutline(content) : []),
    [isMarkdown, content],
  );
  const bookkeeping = useMemo(
    () => (isMarkdown && content ? detectGateBookkeeping(content, gateActionLabels) : []),
    [isMarkdown, content, gateActionLabels],
  );
  const segments = useMemo(() => segmentArtifact(content, bookkeeping), [content, bookkeeping]);
  const matches = useMemo(() => findMatchingLines(content, query), [content, query]);
  const rawLines = useMemo(() => splitLines(content), [content]);
  const currentMatchLine = matches.length > 0 ? matches[Math.min(matchIndex, matches.length - 1)] : null;

  const bodyRef = useRef<HTMLDivElement | null>(null);

  function scrollToLine(line: number) {
    const el = bodyRef.current?.querySelector(`[data-artifact-line="${line}"]`);
    (el as HTMLElement | null)?.scrollIntoView?.({ block: "center" });
  }

  function search(next: string) {
    setQuery(next);
    setMatchIndex(0);
    if (next.trim() && tab !== "raw") setTab("raw");
  }

  function stepMatch(delta: number) {
    if (matches.length === 0) return;
    setMatchIndex((i) => (i + delta + matches.length) % matches.length);
  }

  // Scroll the current hit into view once the raw lines are on screen.
  useEffect(() => {
    if (tab !== "raw" || currentMatchLine == null) return;
    scrollToLine(currentMatchLine);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, currentMatchLine, artifact?.content]);

  function jumpToHeading(heading: MarkdownHeading) {
    if (tab === "rendered") {
      // `slugifyHeading` only ever emits [a-z0-9-], so the id is selector-safe as written.
      const el = bodyRef.current?.querySelector(`#artifact-h-${heading.slug}`);
      (el as HTMLElement | null)?.scrollIntoView?.({ block: "start" });
      return;
    }
    if (tab !== "raw") setTab("raw");
    // The raw lines may not be mounted yet on a tab switch — retry after paint.
    scrollToLine(heading.line);
    setTimeout(() => scrollToLine(heading.line), 0);
  }

  /** Anchor ids on rendered headings, so the outline works in the Rendered tab too. */
  const markdownComponents = useMemo(() => {
    const heading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
      function Heading({ children }: { children?: ReactNode }) {
        return <Tag id={`artifact-h-${slugifyHeading(reactNodeText(children))}`}>{children}</Tag>;
      };
    return { h1: heading("h1"), h2: heading("h2"), h3: heading("h3"), h4: heading("h4"), h5: heading("h5"), h6: heading("h6") };
  }, []);

  // The viewer renders inline BELOW the gate card / loop stats, so opening it from
  // a chip near the top of a long pane put it entirely below the fold — the click
  // appeared to do nothing (measured in the 2026-08-11 UX round). Scroll it into
  // view whenever it opens or switches artifact.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    containerRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [path]);

  // Below sm the viewer is a FULL-SCREEN sheet, not an inline max-h-[60vh] box (#434).
  // Inline, it was the third nested scroll container (pane -> viewer -> diff body): a
  // vertical swipe inside it moved neither the page nor reliably the intended layer, and
  // ~60vh of a phone (with dynamic browser chrome) is too little to read a PRD in. The
  // sheet also makes the ✕ meaningful instead of a way to shrink one box inside another.
  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-40 rounded-none max-h-none sm:static sm:z-auto sm:rounded sm:max-h-[60vh] border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col"
      data-testid="plugin-artifact-viewer"
    >
      <div className="border-b border-gray-100 dark:border-gray-800 px-3 py-2 space-y-1">
        <div className="flex items-center gap-2">
          {/* Which STEP this file belongs to (#423). The path alone only reads as a step
              because THIS plugin encodes the number in it; a plugin writing `docs/prd.md`
              would leave the reader with nothing. */}
          <div className="min-w-0 flex-1">
            {step ? (
              <>
                <div className="text-xs font-medium text-gray-800 dark:text-gray-100 truncate" data-testid="plugin-artifact-step">
                  {step.index && step.total ? `Step ${step.index}/${step.total} — ` : ""}{step.label}
                  {step.version && <span className="ml-1 text-gray-500 dark:text-gray-400 font-normal">{step.version}</span>}
                </div>
                <div className="text-[10px] font-mono text-gray-500 dark:text-gray-400 truncate" title={path}>{path}</div>
              </>
            ) : (
              <span className="text-xs font-mono text-gray-600 dark:text-gray-300 truncate block" title={path}>{path}</span>
            )}
          </div>
          {artifact?.exists && (
            <div className="flex items-center gap-1 text-[11px] shrink-0">
              {(["rendered", "raw"] as const).filter((t) => t !== "rendered" || isMarkdown).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-3 py-2 sm:px-2 sm:py-0.5 min-h-11 sm:min-h-0 rounded ${tab === t ? "bg-brand-600 text-white" : "text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"}`}
                >
                  {t === "rendered" ? "Rendered" : "Raw"}
                </button>
              ))}
              {canDiff && (
                <button
                  onClick={openDiff}
                  className={`px-3 py-2 sm:px-2 sm:py-0.5 min-h-11 sm:min-h-0 rounded ${tab === "diff" ? "bg-brand-600 text-white" : "text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"}`}
                  title="Diff between the artifact's last two committed versions"
                >
                  Diff v-1→v
                </button>
              )}
            </div>
          )}
          <button
            onClick={onClose}
            className="text-xs px-3 py-2 sm:px-2 sm:py-0.5 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 rounded text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 shrink-0"
            aria-label="Close artifact"
          >
            ✕
          </button>
        </div>
        {/* Sibling artifacts of the same step (#422). Without this the step chip opens
            artifacts[0] and the rest of the step's output has no route in the UI at all. */}
        {siblings.length > 1 && onOpenArtifact && (
          <div className="flex flex-wrap items-center gap-1" data-testid="plugin-artifact-siblings">
            {siblings.map((sib) => {
              const active = sib === path;
              return (
                <button
                  key={sib}
                  type="button"
                  onClick={() => !active && onOpenArtifact(sib)}
                  title={sib}
                  aria-current={active ? "true" : undefined}
                  className={`text-[10px] font-mono px-2.5 py-2 sm:px-1.5 sm:py-0.5 min-h-11 sm:min-h-0 rounded border ${
                    active
                      ? "border-brand-500 bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300"
                      : "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                  }`}
                >
                  {sib.split("/").pop()}
                </button>
              );
            })}
          </div>
        )}
        {/* Find-in-document + outline (#452). A check detail names one row of a 50-row table;
            before this the only tool was the browser's Ctrl+F, which inside a 60vh nested
            scroller scrolls the wrong layer as often as the right one. */}
        {artifact?.exists && artifact.content !== null && tab !== "diff" && (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="plugin-artifact-find-bar">
            <input
              type="search"
              value={query}
              onChange={(e) => search(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); } }}
              placeholder="Find in file…"
              // text-base below sm: iOS Safari zooms the page on focus for any input under
              // 16px and never zooms back out (same guard as the gate textarea, #433).
              className="text-base sm:text-[11px] px-2 py-2 sm:py-0.5 min-h-11 sm:min-h-0 w-40 sm:w-52 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
              data-testid="plugin-artifact-find"
            />
            {query.trim() && (
              <>
                <span className="text-[11px] text-gray-500 dark:text-gray-400" data-testid="plugin-artifact-find-count">
                  {matches.length === 0 ? "no matches" : `${Math.min(matchIndex, matches.length - 1) + 1}/${matches.length}`}
                </span>
                <button
                  type="button"
                  onClick={() => stepMatch(-1)}
                  disabled={matches.length === 0}
                  className="text-[11px] px-3 py-2 sm:px-1.5 sm:py-0.5 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 rounded border border-gray-200 dark:border-gray-700 text-gray-500 disabled:opacity-40"
                  aria-label="Previous match"
                >↑</button>
                <button
                  type="button"
                  onClick={() => stepMatch(1)}
                  disabled={matches.length === 0}
                  className="text-[11px] px-3 py-2 sm:px-1.5 sm:py-0.5 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 rounded border border-gray-200 dark:border-gray-700 text-gray-500 disabled:opacity-40"
                  aria-label="Next match"
                  data-testid="plugin-artifact-find-next"
                >↓</button>
              </>
            )}
            {/* Identifiers a failing check quoted — the whole point is not having to retype
                `STORY-2-1 Sz.3` from a paragraph two panes up. */}
            {(findHints ?? []).slice(0, 6).map((hint) => (
              <button
                key={hint}
                type="button"
                onClick={() => search(hint)}
                title={`Find "${hint}" in this file`}
                className={`text-[11px] font-mono px-2.5 py-2 sm:px-1.5 sm:py-0.5 min-h-11 sm:min-h-0 rounded border ${
                  query === hint
                    ? "border-brand-500 bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300"
                    : "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
                data-testid="plugin-artifact-find-hint"
              >
                🔎 {hint}
              </button>
            ))}
            {outline.length > 1 && (
              <details className="relative" data-testid="plugin-artifact-outline">
                <summary className="cursor-pointer select-none text-[11px] px-2.5 py-2 sm:px-1.5 sm:py-0.5 min-h-11 sm:min-h-0 rounded border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400">
                  ☰ Outline ({outline.length})
                </summary>
                <ul className="absolute z-10 mt-1 max-h-64 w-72 overflow-auto rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-1 shadow-lg">
                  {outline.map((heading, i) => (
                    <li key={`${heading.slug}-${i}`}>
                      <button
                        type="button"
                        onClick={() => jumpToHeading(heading)}
                        style={{ paddingLeft: `${(heading.depth - 1) * 10 + 6}px` }}
                        className="block w-full truncate text-left text-[11px] py-1.5 rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                        title={heading.text}
                      >
                        {heading.text}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
      <div ref={bodyRef} className="flex-1 min-h-0 overflow-auto p-3">
        {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
        {!artifact && !error && <div className="text-xs text-gray-500 dark:text-gray-400">Loading…</div>}
        {artifact && !artifact.exists && (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Not produced yet — the file will appear once its step has run.
          </div>
        )}
        {artifact?.exists && diffPending && (
          <div className="text-xs text-gray-500 dark:text-gray-400">Loading diff…</div>
        )}
        {artifact?.exists && artifact.content !== null && !diffPending && (
          tab === "diff" && artifact.diff ? (
            // Full diff surface (#304): syntax highlight + INLINE COMMENTS. Comments stay
            // local; the gate card attaches them to revision feedback as "file:line: note".
            <DiffViewer
              diff={artifact.diff}
              stats={diffStats}
              comments={diffComments}
              onCreateComment={handleCreateComment}
              onEditComment={handleEditComment}
              onDeleteComment={handleDeleteComment}
              onResolveComment={handleResolveComment}
            />
          ) : tab === "rendered" && isMarkdown ? (
            // A PM Pipeline PRD routinely contains wide tables and fenced code. Typography's
            // table/pre do not wrap, so without this they push the whole pane sideways (#434).
            <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:whitespace-pre-wrap prose-pre:break-words prose-table:block prose-table:overflow-x-auto prose-img:max-w-full">
              {segments.map((segment, i) =>
                segment.kind === "markdown" ? (
                  <ReactMarkdown key={`md-${i}`} components={markdownComponents}>{segment.text}</ReactMarkdown>
                ) : (
                  <details
                    key={`bk-${i}`}
                    className="not-prose my-2 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 px-2.5 py-1.5"
                    data-testid="plugin-artifact-bookkeeping"
                    data-bookkeeping-answered={segment.block.answered ? "true" : "false"}
                  >
                    <summary className="cursor-pointer select-none text-[11px] text-gray-500 dark:text-gray-400">
                      🔒 Plugin bookkeeping: {segment.block.heading}
                      {segment.block.feedbackHeading ? ` + ${segment.block.feedbackHeading}` : ""} —{" "}
                      {segment.block.answered
                        ? `recorded in the file (${segment.block.items.filter((it) => it.checked).map((it) => it.label).join(", ")})`
                        : "not yet answered; use the gate buttons, not this file"}
                    </summary>
                    <pre className="mt-1 text-[11px] whitespace-pre-wrap break-words text-gray-500 dark:text-gray-400">
                      {segment.text.trim()}
                    </pre>
                  </details>
                ),
              )}
            </div>
          ) : (
            // Raw is line-addressed (#452): every line carries its number so find, the outline
            // and a check's quoted identifier can all scroll to it and highlight it.
            <pre className="text-[11px] text-gray-700 dark:text-gray-300" data-testid="plugin-artifact-raw">
              {rawLines.map((line, i) => (
                <div
                  key={i}
                  data-artifact-line={i}
                  className={`whitespace-pre-wrap break-all ${
                    currentMatchLine === i ? "bg-amber-100 dark:bg-amber-900/40 rounded" : ""
                  }`}
                >
                  {query.trim()
                    ? splitHighlight(line, query).map((part, j) =>
                        part.hit
                          ? <mark key={j} className="bg-amber-300 dark:bg-amber-600 dark:text-white rounded-sm">{part.text}</mark>
                          : <span key={j}>{part.text}</span>,
                      )
                    : line}
                  {line.trim() === "" ? " " : ""}
                </div>
              ))}
            </pre>
          )
        )}
        {artifact?.truncated && (
          <div className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">Truncated — the full file is in the repo.</div>
        )}
      </div>
    </div>
  );
}

// ── Timeline + cost (#292, #294) ─────────────────────────────────────

type LoopEventsResponse = {
  events: Array<{ id: string; type: string; payload: Record<string, unknown> | null; createdAt: string }>;
  cost: { totalUsd: number; byUnit: Array<{ unitId: string; costUsd: number; sessions: number }> };
};

function eventSummary(event: LoopEventsResponse["events"][number]): string {
  const p = event.payload ?? {};
  switch (event.type) {
    case "advance": {
      const created = Array.isArray(p.created) ? p.created.length : 0;
      const note = typeof p.note === "string" && p.note ? ` — ${p.note}` : "";
      return created > 0 ? `Advanced: ${created} ticket(s) created${note}` : `Advanced: nothing planned${note}`;
    }
    case "gate-reached":
      return `Reached gate: ${typeof p.question === "string" ? p.question : String(p.gateId ?? "")}`;
    case "gate-resolved": {
      const input = typeof p.input === "string" && p.input ? ` — "${p.input.slice(0, 120)}"` : "";
      return `Decision: ${String(p.actionLabel ?? p.actionId ?? "?")}${input}`;
    }
    case "gate-recommendation":
      return `Butler pre-read: ${typeof p.actionId === "string" ? p.actionId : "?"}`
        + (typeof p.reason === "string" && p.reason ? ` — ${p.reason}` : "");
    // Why a gate got no pre-read. Without this the absence of a chip was indistinguishable
    // from the feature being off, the butler being cold, or the model replying garbage.
    case "gate-recommendation-skipped":
      return `No butler pre-read (${typeof p.reason === "string" ? p.reason : "unknown"})`
        + (typeof p.detail === "string" && p.detail ? ` — ${p.detail}` : "");
    case "paused": return "Paused by a human";
    case "resumed": return "Resumed";
    case "converged": return "Converged — nothing left to do";
    default: return event.type;
  }
}

const EVENT_MARK: Record<string, string> = {
  "advance": "▸",
  "gate-reached": "✋",
  "gate-resolved": "✔",
  "gate-recommendation": "🤵",
  "gate-recommendation-skipped": "◌",
  "paused": "⏸",
  "resumed": "▶",
  "converged": "★",
};

/**
 * #412 — the loop's audit timeline was nearly undiscoverable: a COLLAPSED toggle at the
 * very bottom of the pane, labelled neither "timeline" nor "events" (a DOM text search for
 * `timeline|events` across the whole Plugins view returned zero hits), showing nothing at
 * all until clicked. Diagnosing "why is nothing happening" therefore sent operators to curl
 * the events API. Three changes, all cheap: name it, let the collapsed toggle advertise its
 * most recent event, and open it by default while a gate is waiting — the moment a human is
 * deciding is exactly when the recent history matters.
 */
export function LoopTimeline({ pluginId, loopName, projectId, refreshKey, hasGate = false }: {
  pluginId: string;
  loopName: string;
  projectId: string;
  /** Bump to refetch (e.g. after an advance or gate decision). */
  refreshKey: number;
  /** This loop is blocked on a human right now — open the history unasked. */
  hasGate?: boolean;
}) {
  const [open, setOpen] = useState(hasGate);
  const [data, setData] = useState<LoopEventsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Auto-open when a gate APPEARS (the surface usually loads after this mounts). Only on the
  // transition, so a human who deliberately collapsed it is not fought on the next poll.
  const sawGateRef = useRef(hasGate);
  useEffect(() => {
    if (hasGate && !sawGateRef.current) setOpen(true);
    sawGateRef.current = hasGate;
  }, [hasGate]);

  // Fetched whether or not it is open: the collapsed label shows the latest event, which is
  // the whole point of the change — and it makes expanding instant instead of a loading flash.
  useEffect(() => {
    let cancelled = false;
    apiFetch<LoopEventsResponse>(
      `/api/plugins/${pluginId}/loops/${encodeURIComponent(loopName)}/events?projectId=${projectId}&limit=50`,
    )
      .then((res) => { if (!cancelled) { setData(res); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [pluginId, loopName, projectId, refreshKey]);

  const latest = data?.events[0];
  return (
    <div className="border-t border-gray-100 dark:border-gray-800 pt-3" data-testid="plugin-loop-timeline">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-full items-baseline gap-1.5 text-left text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
      >
        <span className="shrink-0">{open ? "▾" : "▸"} Timeline &amp; cost</span>
        {/* Collapsed, this used to show NOTHING — so the toggle advertised neither what it
            held nor that anything had happened. The newest event is the one line that makes
            "is this loop doing something?" answerable without a click. */}
        {!open && latest && (
          <span className="truncate text-gray-400 dark:text-gray-500" data-testid="plugin-loop-timeline-latest">
            · {EVENT_MARK[latest.type] ?? "·"} {eventSummary(latest)} — {formatRelativeTime(latest.createdAt)}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
          {!data && !error && <div className="text-xs text-gray-400">Loading…</div>}
          {data && (
            <>
              {(data.cost.totalUsd > 0 || data.cost.byUnit.length > 0) && (
                <div className="text-xs text-gray-600 dark:text-gray-300">
                  Total agent cost: <span className="font-medium">${data.cost.totalUsd.toFixed(2)}</span>
                  {data.cost.byUnit.length > 0 && (
                    <span className="text-gray-400 dark:text-gray-500">
                      {" "}({data.cost.byUnit.slice(0, 5).map((u) => `${u.unitId}: $${u.costUsd.toFixed(2)}`).join(" · ")})
                    </span>
                  )}
                </div>
              )}
              <ul className="space-y-1">
                {data.events.map((event) => (
                  <li key={event.id} className="text-[11px] text-gray-600 dark:text-gray-300 flex items-baseline gap-1.5">
                    <span className="text-gray-400 dark:text-gray-500 w-3 shrink-0" aria-hidden="true">{EVENT_MARK[event.type] ?? "·"}</span>
                    <span className="flex-1">{eventSummary(event)}</span>
                    <span className="text-gray-400 dark:text-gray-500 shrink-0">{formatRelativeTime(event.createdAt)}</span>
                  </li>
                ))}
                {data.events.length === 0 && <li className="text-[11px] text-gray-400">No history yet.</li>}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
