import { useEffect, useRef, useState } from "react";
import { priorityColors } from "../lib/issueCardColorMap.js";
import type { ProjectTag, TagBadge } from "./IssueCard.js";

const PRIORITIES = ["critical", "high", "medium", "low"] as const;

export function PriorityDropdown({ priority, onChange }: { priority: string; onChange: (p: string) => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const current = priority ?? "medium";
  const color = priorityColors[current] ?? "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400";

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  async function select(p: string) {
    setOpen(false);
    if (p === current || saving) return;
    setSaving(true);
    try {
      await onChange(p);
    } finally {
      setSaving(false);
    }
  }

  return (
    <span ref={ref} className="relative inline-flex shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={saving}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className={`inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded capitalize transition-opacity ${color} ${saving ? "opacity-50" : "hover:ring-1 hover:ring-current/40"}`}
        title="Change priority"
      >
        {current}
        <svg className="w-2.5 h-2.5 shrink-0 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <span className="absolute left-0 top-full z-30 mt-1 min-w-[7rem] rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">
          {PRIORITIES.map((p) => (
            <button
              key={p}
              type="button"
              onClick={(e) => { e.stopPropagation(); void select(p); }}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs capitalize hover:bg-gray-50 dark:hover:bg-gray-800 ${p === current ? "font-semibold" : "font-medium"}`}
            >
              <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${p === "critical" ? "bg-red-500" : p === "high" ? "bg-orange-500" : p === "medium" ? "bg-yellow-400" : "bg-gray-400"}`} />
              {p}
              {p === current && (
                <svg className="ml-auto w-3 h-3 text-brand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

export function InlineTagEditor({
  tags,
  allProjectTags,
  onAdd,
  onRemove,
}: {
  tags: TagBadge[];
  allProjectTags: ProjectTag[];
  onAdd: (tagId: string) => Promise<void>;
  onRemove: (tagId: string) => Promise<void>;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [savingTag, setSavingTag] = useState<string | null>(null);
  const addRef = useRef<HTMLSpanElement>(null);
  const assignedIds = new Set(tags.map((t) => t.id));
  const available = allProjectTags.filter((t) => !assignedIds.has(t.id));

  useEffect(() => {
    if (!addOpen) return;
    function handlePointerDown(e: MouseEvent) {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setAddOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [addOpen]);

  async function handleRemove(tagId: string) {
    if (savingTag) return;
    setSavingTag(tagId);
    try {
      await onRemove(tagId);
    } finally {
      setSavingTag(null);
    }
  }

  async function handleAdd(tagId: string) {
    setAddOpen(false);
    if (savingTag) return;
    setSavingTag(tagId);
    try {
      await onAdd(tagId);
    } finally {
      setSavingTag(null);
    }
  }

  return (
    <>
      {tags.map((tag) => (
        <span
          key={tag.id}
          className="inline-flex items-center gap-0.5 text-xs px-1 py-0.5 rounded"
          style={
            tag.name === "needs-visual-verification"
              ? { backgroundColor: "#F59E0B22", color: "#F59E0B" }
              : tag.color
              ? { backgroundColor: tag.color + "22", color: tag.color }
              : undefined
          }
          onClick={(e) => e.stopPropagation()}
        >
          <span className="truncate max-w-[6rem]">{tag.name === "needs-visual-verification" ? "verify" : tag.name}</span>
          <button
            type="button"
            disabled={savingTag === tag.id}
            onClick={(e) => { e.stopPropagation(); void handleRemove(tag.id); }}
            className={`ml-0.5 rounded-full opacity-50 hover:opacity-100 transition-opacity ${savingTag === tag.id ? "cursor-wait" : ""}`}
            title={`Remove tag: ${tag.name}`}
            aria-label={`Remove tag ${tag.name}`}
          >
            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
      ))}
      {available.length > 0 && (
        <span ref={addRef} className="relative inline-flex shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setAddOpen((v) => !v); }}
            className="inline-flex items-center gap-0.5 text-xs px-1 py-0.5 rounded text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-300 transition-colors opacity-0 group-hover:opacity-100"
            title="Add tag"
            aria-label="Add tag"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </button>
          {addOpen && (
            <span className="absolute left-0 top-full z-30 mt-1 min-w-[9rem] max-h-40 overflow-y-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">
              {available.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  disabled={savingTag === tag.id}
                  onClick={(e) => { e.stopPropagation(); void handleAdd(tag.id); }}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <span
                    className="inline-block w-2 h-2 rounded-full shrink-0 bg-gray-300"
                    style={tag.color ? { backgroundColor: tag.color } : undefined}
                  />
                  <span className="truncate">{tag.name}</span>
                </button>
              ))}
            </span>
          )}
        </span>
      )}
    </>
  );
}
