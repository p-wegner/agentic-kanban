import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { INBOX_KIND_MARK, openInboxItem, useInbox, type InboxItem } from "../hooks/useInbox.js";

/**
 * #411 — a waiting gate used to be invisible outside the Plugins view. MEASURED on the
 * live board: pmqa's pipeline sat at gate `step-7:v3` for 1d 3h while its Board view
 * showed empty columns and "Completed 17 (all done)" — the project actively looked
 * FINISHED while the pipeline was paused on a human. The only cues were a generic red
 * bell badge and opening Plugins ▾ per project.
 *
 * So the chip lives in the header, next to the project switcher: present in EVERY view,
 * not just the board, and clicking it lands exactly where the decision is made (the same
 * `openInboxItem` navigation the bell entry uses).
 */
/**
 * The head of a gate question, short enough for a header chip.
 *
 * Gate titles are long and carry their warnings inline — the live pm-pipeline one reads
 * "Approve step 7/9 — Test & QA (plan + execution) (v1)? ⚠ 8 of 50 acceptance criteria are
 * UNEXECUTED …". Cutting at the first sentence/clause boundary keeps the identifying part
 * ("Approve step 7/9") instead of a mid-word truncation of the first warning.
 */
export function waitingChipLabel(title: string): string {
  return title.split(/[?—·]/)[0].trim().slice(0, 42) || "Decision waiting";
}

export function WaitingOnYouChip({ activeProjectId }: { activeProjectId: string | null }) {
  const { items } = useInbox();
  if (!activeProjectId) return null;

  const mine = (items ?? []).filter((item) => item.projectId === activeProjectId);
  if (mine.length === 0) return null;

  const first: InboxItem = mine[0];
  // The chip gets the short head of the question; the tooltip keeps the whole thing.
  const label = waitingChipLabel(first.title);
  const age = first.createdAt ? formatRelativeTime(first.createdAt).replace(" ago", "") : null;

  return (
    <button
      type="button"
      onClick={() => openInboxItem(first)}
      data-testid="waiting-on-you-chip"
      title={mine.map((i) => `${i.title}${i.detail ? ` — ${i.detail}` : ""}`).join("\n\n")}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 text-xs font-medium text-amber-800 transition hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200 dark:hover:bg-amber-900/50"
    >
      <span aria-hidden="true">{INBOX_KIND_MARK[first.kind]}</span>
      <span className="hidden sm:inline max-w-[14rem] truncate">
        Waiting on you — {label}
      </span>
      <span className="sm:hidden">Waiting</span>
      {age && <span className="tabular-nums opacity-75">{age}</span>}
      {mine.length > 1 && (
        <span className="rounded-full bg-amber-200 px-1.5 leading-4 dark:bg-amber-800">+{mine.length - 1}</span>
      )}
    </button>
  );
}
