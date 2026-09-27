import type { MergeActivitySummary, MergeActivityTicket } from "@agentic-kanban/shared/types";
import {
  finishedOutcome,
  formatElapsed,
  liveTrainVerb,
  shortTrainLabel,
  sinceMs,
} from "../lib/deliveryMergeActivity.js";
import { requestIssueFocus } from "../lib/navigateView.js";

/**
 * The Delivery panel's "Merging now" section: the live train's members with its state and
 * elapsed time, the ready tickets waiting, and the last finished train's outcome. Each ticket
 * row opens that ticket's workspace drawer.
 */
export function DeliveryMergeActivityBody({ activity, nowMs }: { activity: MergeActivitySummary; nowMs: number }) {
  const { current, lastFinished, waiting } = activity;
  return (
    <div data-testid="delivery-merge-activity">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint dark:text-gray-500">Merging now</div>
      {current ? (
        <div data-testid="delivery-merge-current">
          <div className={`text-[11px] font-medium ${current.bisecting ? "text-amber-700 dark:text-amber-400" : ""}`}>
            {liveTrainVerb(current)} {shortTrainLabel(current.label)} · {formatElapsed(sinceMs(current.startedAt, nowMs))}
          </div>
          <TicketRows tickets={current.members} />
        </div>
      ) : (
        <div className="text-[11px] text-ink-soft dark:text-gray-400">No train running.</div>
      )}
      {waiting.length > 0 && (
        <div className="mt-2" data-testid="delivery-merge-waiting">
          <div className="text-[11px] font-medium">{waiting.length} ready, waiting</div>
          <TicketRows tickets={waiting} ages={waiting.map((w) => formatElapsed(sinceMs(w.readySince, nowMs)))} />
        </div>
      )}
      {lastFinished && (
        <div
          className={`mt-2 text-[11px] ${lastFinished.state === "landed" ? "text-ink-soft dark:text-gray-400" : "text-red-600 dark:text-red-400"}`}
          data-testid="delivery-merge-last"
        >
          Last: {shortTrainLabel(lastFinished.label)} {finishedOutcome(lastFinished)}, {formatElapsed(sinceMs(lastFinished.finishedAt, nowMs))} ago
          {lastFinished.failureSummary && <div className="truncate" title={lastFinished.failureSummary}>{lastFinished.failureSummary}</div>}
          <TicketRows tickets={lastFinished.members} />
        </div>
      )}
    </div>
  );
}

function TicketRows({ tickets, ages }: { tickets: MergeActivityTicket[]; ages?: string[] }) {
  if (tickets.length === 0) return null;
  return (
    <ul className="mt-0.5 space-y-0.5">
      {tickets.map((t, i) => (
        <li key={t.workspaceId} className="flex items-center gap-1 min-w-0">
          <button
            type="button"
            disabled={t.issueNumber == null}
            onClick={() => requestIssueFocus({ issueNumber: t.issueNumber, panel: "workspace", workspaceId: t.workspaceId })}
            className="min-w-0 flex-1 truncate text-left text-[11px] text-accent-700 dark:text-accent-400 hover:underline disabled:no-underline disabled:text-ink-faint"
          >
            {t.issueNumber != null ? `#${t.issueNumber}` : t.workspaceId.slice(0, 8)} {t.title ?? ""}
          </button>
          {ages?.[i] && <span className="shrink-0 text-[10px] text-ink-faint dark:text-gray-500">{ages[i]}</span>}
        </li>
      ))}
    </ul>
  );
}
