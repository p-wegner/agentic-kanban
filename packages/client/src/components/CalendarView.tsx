import { useCallback, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { STATUS_COLORS } from "../lib/chartColors";
import { getLocalDateKey } from "../lib/dateKey";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CalendarViewProps {
  columns: StatusWithIssues[];
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_VISIBLE_CHIPS = 3;
type CalendarDateField = "createdAt" | "updatedAt" | "statusChangedAt";

const DATE_FIELD_OPTIONS: Array<{ value: CalendarDateField; label: string }> = [
  { value: "createdAt", label: "Created" },
  { value: "updatedAt", label: "Updated" },
  { value: "statusChangedAt", label: "Status changed" },
];

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

function isToday(year: number, month: number, day: number): boolean {
  const now = new Date();
  return now.getFullYear() === year && now.getMonth() === month && now.getDate() === day;
}

function escapeHandler(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key === "Escape") e.stopPropagation();
}

function colorWithAlpha(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) return hex;
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CalendarHeader({
  monthLabel,
  onPrev,
  onNext,
  onToday,
  dateField,
  onDateFieldChange,
}: {
  monthLabel: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  dateField: CalendarDateField;
  onDateFieldChange: (field: CalendarDateField) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3 px-1 flex-wrap">
      <div className="flex items-center gap-2">
        <button
          onClick={onPrev}
          className="p-1.5 rounded hover:bg-ink-faint/10 text-ink-faint hover:text-ink transition-colors"
          aria-label="Previous month"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <button
          onClick={onNext}
          className="p-1.5 rounded hover:bg-ink-faint/10 text-ink-faint hover:text-ink transition-colors"
          aria-label="Next month"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <button
          onClick={onToday}
          className="px-2 py-0.5 text-xs rounded border border-ink-faint/20 text-ink-faint hover:text-ink hover:border-ink/30 transition-colors"
        >
          Today
        </button>
      </div>

      <h2 className="text-sm font-semibold text-ink">{monthLabel}</h2>

      <div className="flex items-center gap-1 rounded-md border border-ink-faint/15 bg-surface-raised dark:bg-surface-raised-dark p-0.5" aria-label="Calendar date field">
        {DATE_FIELD_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onDateFieldChange(option.value)}
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
              dateField === option.value
                ? "bg-brand-600 text-white"
                : "text-ink-faint hover:bg-ink-faint/10 hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function CalendarIssueChip({
  issue,
  onClick,
}: {
  issue: IssueWithStatus;
  onClick: () => void;
}) {
  const color = STATUS_COLORS[issue.statusName] ?? "#8a8175";
  const label = issue.issueNumber != null ? `#${issue.issueNumber} ${issue.title}` : issue.title;

  return (
    <button
      onClick={onClick}
      title={label}
      className={`
        w-full text-left px-1.5 py-0.5 rounded text-[11px] leading-tight truncate cursor-pointer
        border-l-[3px] transition-colors hover:bg-ink-faint/5
        text-ink/80 dark:text-ink/70
      `}
      style={{ borderLeftColor: color, backgroundColor: colorWithAlpha(color, 0.08) }}
    >
      {label}
    </button>
  );
}

function CalendarDayCell({
  day,
  isOutsideMonth,
  isCurrentDay,
  issues,
  onIssueClick,
}: {
  day: number;
  isOutsideMonth: boolean;
  isCurrentDay: boolean;
  issues: IssueWithStatus[];
  onIssueClick: (issue: IssueWithStatus) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const cellRef = useRef<HTMLDivElement>(null);

  const visible = issues.slice(0, MAX_VISIBLE_CHIPS);
  const overflow = issues.length - MAX_VISIBLE_CHIPS;

  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);

  return (
    <div
      ref={cellRef}
      className={`
        min-h-[90px] p-1 border border-ink-faint/10 relative
        ${isOutsideMonth ? "bg-ink-faint/[0.03]" : "bg-surface"}
        ${isCurrentDay ? "ring-1 ring-brand-400 ring-inset" : ""}
      `}
    >
      <span
        className={`
          text-[11px] font-medium block mb-0.5
          ${isCurrentDay ? "text-brand-600 dark:text-brand-400 font-bold" : ""}
          ${isOutsideMonth ? "text-ink-faint/40" : "text-ink-faint"}
        `}
      >
        {day}
      </span>

      <div className="space-y-0.5">
        {visible.map((issue) => (
          <CalendarIssueChip
            key={issue.id}
            issue={issue}
            onClick={() => onIssueClick(issue)}
          />
        ))}
      </div>

      {overflow > 0 && !expanded && (
        <button
          onClick={toggleExpanded}
          className="text-[10px] text-ink-faint hover:text-ink mt-0.5 px-1"
        >
          +{overflow} more…
        </button>
      )}

      {expanded && (
        <div className="absolute inset-x-0 top-0 z-10 bg-surface border border-ink-faint/20 rounded shadow-lg p-1 space-y-0.5">
          {issues.map((issue) => (
            <CalendarIssueChip
              key={issue.id}
              issue={issue}
              onClick={() => { onIssueClick(issue); setExpanded(false); }}
            />
          ))}
          <button
            onClick={toggleExpanded}
            className="text-[10px] text-ink-faint hover:text-ink px-1"
          >
            Show less
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CalendarView({ columns, onIssueClick, searchQuery = "" }: CalendarViewProps) {
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [dateField, setDateField] = useState<CalendarDateField>("createdAt");

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  // Flatten, filter, and place issues by the selected board timestamp.
  const dated = useMemo(() => {
    const query = searchQuery.toLowerCase();
    const all: IssueWithStatus[] = [];
    for (const col of columns) {
      for (const issue of col.issues) {
        if (query && !issue.title.toLowerCase().includes(query) && !(issue.issueNumber != null && String(issue.issueNumber).includes(query))) continue;
        all.push(issue);
      }
    }

    const datedMap = new Map<string, IssueWithStatus[]>();

    for (const issue of all) {
      const rawDate = issue[dateField];
      if (!rawDate) continue;
      const key = getLocalDateKey(rawDate);
      const arr = datedMap.get(key);
      if (arr) arr.push(issue);
      else datedMap.set(key, [issue]);
    }

    for (const issues of datedMap.values()) {
      issues.sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
    }

    return datedMap;
  }, [columns, dateField, searchQuery]);

  // Grid calculations
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfWeek(year, month);
  const prevMonthDays = getDaysInMonth(year, month - 1);
  const totalCells = Math.ceil((firstDay + daysInMonth) / 7) * 7;

  // Build cell data
  const cells = useMemo(() => {
    const result: Array<{ day: number; dateKey: string; isOutsideMonth: boolean }> = [];
    for (let i = 0; i < totalCells; i++) {
      if (i < firstDay) {
        // Previous month
        const day = prevMonthDays - firstDay + i + 1;
        const m = month === 0 ? 11 : month - 1;
        const y = month === 0 ? year - 1 : year;
        result.push({ day, dateKey: getLocalDateKey(new Date(y, m, day)), isOutsideMonth: true });
      } else if (i >= firstDay + daysInMonth) {
        // Next month
        const day = i - firstDay - daysInMonth + 1;
        const m = month === 11 ? 0 : month + 1;
        const y = month === 11 ? year + 1 : year;
        result.push({ day, dateKey: getLocalDateKey(new Date(y, m, day)), isOutsideMonth: true });
      } else {
        // Current month
        const day = i - firstDay + 1;
        result.push({ day, dateKey: getLocalDateKey(new Date(year, month, day)), isOutsideMonth: false });
      }
    }
    return result;
  }, [year, month, firstDay, daysInMonth, prevMonthDays, totalCells]);

  const monthLabel = new Date(year, month).toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const goToPrevMonth = useCallback(() => {
    setCurrentDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
  }, []);

  const goToNextMonth = useCallback(() => {
    setCurrentDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1));
  }, []);

  const goToToday = useCallback(() => {
    setCurrentDate(new Date());
  }, []);

  return (
    <div className="flex flex-col h-full" onKeyDown={escapeHandler}>
      <CalendarHeader
        monthLabel={monthLabel}
        onPrev={goToPrevMonth}
        onNext={goToNextMonth}
        onToday={goToToday}
        dateField={dateField}
        onDateFieldChange={setDateField}
      />

      {/* Day-of-week headers */}
      <div className="grid grid-cols-7">
        {DAY_LABELS.map((d) => (
          <div key={d} className="text-[10px] font-medium text-ink-faint text-center py-1 border-b border-ink-faint/10">
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 flex-1 overflow-auto">
        {cells.map((cell, idx) => (
          <CalendarDayCell
            key={idx}
            day={cell.day}
            isOutsideMonth={cell.isOutsideMonth}
            isCurrentDay={!cell.isOutsideMonth && isToday(year, month, cell.day)}
            issues={cell.isOutsideMonth ? [] : dated.get(cell.dateKey) ?? []}
            onIssueClick={onIssueClick}
          />
        ))}
      </div>
    </div>
  );
}
