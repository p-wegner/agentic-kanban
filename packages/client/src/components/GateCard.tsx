import { useEffect, useState } from "react";
import { apiFetch, apiPost, apiPut } from "../lib/api.js";
import { showToast } from "./Toast.js";
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
} from "../lib/gateCardPolicy.js";
import type { PluginCheck, PluginGate, PluginGateAction } from "./PluginLoopExtras.js";

// ── Approval gate card (#286) ─────────────────────────────────────────
//
// Split out of PluginLoopExtras (#465) so that file stays under the god-module ceiling — this
// card's state machine (select action → arm textarea → confirm) is a cohesive, independently
// testable unit.

type GateResolveResponse = {
  gateId: string;
  actionId: string;
  resolve: { code: number | null; stdout: string; stderr: string; timedOut: boolean };
  advance: { note: string | null; created: Array<{ issueNumber: number | null; title: string }> } | null;
};

/** Compact age for the gate badge — minutes under an hour, then hours, then days. */
export function formatGateAge(since: string): string {
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
          revision") cannot share a line with the others at any phone width.

          From `lg` it also STICKS to the bottom of the loop pane's decision column (#447).
          MEASURED on the live gate: even with the card leading its column, the butler
          pre-read plus two blocking findings make it ~700px tall, so "Needs revision" landed
          at y=892 in a 900px viewport and was clipped by the column's own bottom edge. The
          whole point of the split layout is that the answer is reachable while you read, so
          the answer must not depend on where the card happens to end. */}
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 lg:sticky lg:bottom-0 lg:-mx-4 lg:-mb-4 lg:px-4 lg:py-2 lg:bg-amber-50 lg:dark:bg-[#3a2a12] lg:border-t lg:border-amber-200 lg:dark:border-amber-800">
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
