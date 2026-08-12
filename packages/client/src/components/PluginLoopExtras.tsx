import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { DiffComment, CreateDiffCommentRequest } from "@agentic-kanban/shared";
import { apiFetch, apiPost, apiPut } from "../lib/api.js";
import { showToast } from "./Toast.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { DiffViewer } from "./DiffViewer.js";
import {
  canSubmitGateAction,
  gateFeedbackText,
  gateInputPlaceholder,
  gateInputRequirementHint,
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
 */
export function splitGateQuestion(
  question: string,
  checks?: Array<{ detail?: string | null }> | null,
): { heading: string; duplicatedDetail: string | null } {
  const boundary = question.indexOf("?");
  if (boundary === -1 || boundary === question.length - 1) {
    return { heading: question, duplicatedDetail: null };
  }
  const heading = question.slice(0, boundary + 1);
  const tail = question.slice(boundary + 1).replace(/^[\s⚠!*-]+/, "").trim();
  if (!tail) return { heading, duplicatedDetail: null };

  // The tail is a TRUNCATION of the check detail, so compare a prefix rather than the whole
  // string. Long enough not to collide by accident, short enough to survive the truncation.
  const probe = normalizeForCompare(tail).slice(0, 40);
  if (probe.length < 20) return { heading: question, duplicatedDetail: null };
  const echoed = (checks ?? []).some((check) =>
    check.detail ? normalizeForCompare(check.detail).includes(probe) : false);
  return echoed ? { heading, duplicatedDetail: tail } : { heading: question, duplicatedDetail: null };
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

  const questionView = splitGateQuestion(gate.question, checks);

  return (
    <div
      className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4 space-y-3 max-w-2xl"
      data-testid="plugin-gate-card"
    >
      <div className="text-sm font-medium text-amber-900 dark:text-amber-200" data-testid="plugin-gate-question">
        ✋ {questionView.heading}
      </div>
      {/* How long this decision has been blocking the pipeline. Sourced from the gate's own
          `gate-reached` event, so a re-planned loop cannot make an old gate look fresh. */}
      {gateSince && (
        <div className="text-xs text-amber-800 dark:text-amber-300" data-testid="plugin-gate-age">
          Waiting {formatGateAge(gateSince)} · since {new Date(gateSince).toLocaleString("en-US")}
        </div>
      )}
      {/* Butler recommendation chip (#309) — a pre-read, never a decision.
          A recommendation whose action is no longer offered stays visible but loses its Accept
          button (#378 A): the chip was handing out a one-click path to an action the gate had
          deliberately withdrawn, and the click was silently inert. */}
      {recommendation && recommendationView && (
        <div
          className="flex items-start gap-2 text-xs rounded border border-amber-200 dark:border-amber-800 bg-white/60 dark:bg-gray-900/40 px-2 py-1.5"
          data-testid="plugin-gate-recommendation"
          data-recommendation-state={recommendationView.actionable ? "actionable" : recommendationView.skipReason}
        >
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
          </span>
          {recommendationView.actionable && (
            <button
              onClick={() => void act(recommendationView.action)}
              disabled={resolving}
              className="shrink-0 max-w-[12rem] truncate text-[11px] px-3 py-2.5 sm:px-2 sm:py-0.5 min-h-11 sm:min-h-0 rounded border border-amber-400 dark:border-amber-600 hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-900 dark:text-amber-200"
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
      {/* Verification digest (#303) — verdict + detail readable on the card itself. */}
      {(checks?.length ?? 0) > 0 && (
        <div className="space-y-1" data-testid="plugin-gate-checks-digest">
          {checks!.map((check) => (
            <div key={check.name} className={`text-xs ${checkTone[check.verdict]}`}>
              <span className="font-medium">{check.verdict === "pass" ? "✓" : check.verdict === "warn" ? "⚠" : "✕"} {check.name}:</span>{" "}
              {check.detail ?? check.verdict.toUpperCase()}
            </div>
          ))}
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
      {(gate.artifacts?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {gate.artifacts!.map((path) => (
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
        </div>
      )}
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
        {gate.actions.map((action) => (
          <button
            key={action.id}
            onClick={() => void act(action)}
            // #378 B — once the textarea is armed this button IS the confirm; a required-input
            // action with an empty box must not look clickable and then do nothing.
            disabled={resolving || (selected?.id === action.id && !canSubmitGateAction(action, input, lineNotes))}
            className={`text-sm px-4 py-2.5 sm:px-3 sm:py-1.5 min-h-11 sm:min-h-0 rounded disabled:opacity-50 disabled:cursor-not-allowed ${
              action.input === "text"
                ? "border border-amber-400 dark:border-amber-600 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                : "bg-brand-600 text-white hover:bg-brand-700"
            }`}
            data-testid={`plugin-gate-action-${action.id}`}
          >
            {resolving ? "Applying…" : selected?.id === action.id && action.input === "text" ? `Confirm: ${action.label}` : action.label}
          </button>
        ))}
        <button
          onClick={() => void summarize()}
          disabled={summarizing}
          className="text-sm px-4 py-2.5 sm:px-3 sm:py-1.5 min-h-11 sm:min-h-0 rounded border border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
          data-testid="plugin-gate-summarize"
          title="Butler reads the artifacts and posts a decision-ready digest here (#330)"
        >
          {summarizing ? "Summarizing…" : "🤵 Summarize for me"}
        </button>
      </div>
    </div>
  );
}

// ── Artifact viewer (#288) ────────────────────────────────────────────

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

export function ArtifactViewer({ pluginId, loopName, projectId, path, step, onOpenArtifact, onClose, onLineNotesChange }: {
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
    setTab("rendered");
    setWantDiff(false);
    return () => { cancelled = true; void cancelled; };
  }, [pluginId, loopName, projectId, path]);

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

  // The viewer renders inline BELOW the gate card / loop stats, so opening it from
  // a chip near the top of a long pane put it entirely below the fold — the click
  // appeared to do nothing (measured in the 2026-08-11 UX round). Scroll it into
  // view whenever it opens or switches artifact.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    containerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3">
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
              <ReactMarkdown>{artifact.content}</ReactMarkdown>
            </div>
          ) : (
            <pre className="text-[11px] whitespace-pre-wrap break-all text-gray-700 dark:text-gray-300">{artifact.content}</pre>
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
