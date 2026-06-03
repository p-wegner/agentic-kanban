import React from "react";

interface ToolbarAction {
  label: string;
  title: string;
  icon: React.ReactNode;
  action: (selected: string) => { prefix: string; suffix: string; placeholder: string };
}

const ACTIONS: ToolbarAction[] = [
  {
    label: "B",
    title: "Bold",
    icon: <strong>B</strong>,
    action: (sel) => ({ prefix: "**", suffix: "**", placeholder: sel || "bold text" }),
  },
  {
    label: "I",
    title: "Italic",
    icon: <em>I</em>,
    action: (sel) => ({ prefix: "_", suffix: "_", placeholder: sel || "italic text" }),
  },
  {
    label: "`",
    title: "Inline code",
    icon: <code className="font-mono text-xs">`c`</code>,
    action: (sel) => ({ prefix: "`", suffix: "`", placeholder: sel || "code" }),
  },
  {
    label: "link",
    title: "Link",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
      </svg>
    ),
    action: (sel) => ({
      prefix: "[",
      suffix: "](url)",
      placeholder: sel || "link text",
    }),
  },
  {
    label: "ul",
    title: "Bullet list",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    ),
    action: (sel) => ({ prefix: "- ", suffix: "", placeholder: sel || "list item" }),
  },
  {
    label: "cl",
    title: "Checklist",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    action: (sel) => ({ prefix: "- [ ] ", suffix: "", placeholder: sel || "task" }),
  },
];

interface MarkdownToolbarProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
}

export function MarkdownToolbar({ textareaRef, value, onChange }: MarkdownToolbarProps) {
  function applyAction(action: ToolbarAction) {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const selected = value.slice(start, end);
    const { prefix, suffix, placeholder } = action.action(selected);
    const insert = selected ? `${prefix}${selected}${suffix}` : `${prefix}${placeholder}${suffix}`;
    const newValue = value.slice(0, start) + insert + value.slice(end);
    onChange(newValue);

    // restore focus and select the inserted content
    requestAnimationFrame(() => {
      textarea.focus();
      if (selected) {
        textarea.setSelectionRange(start, start + insert.length);
      } else {
        // select just the placeholder text so the user can type over it
        const placeholderStart = start + prefix.length;
        const placeholderEnd = placeholderStart + placeholder.length;
        textarea.setSelectionRange(placeholderStart, placeholderEnd);
      }
    });
  }

  return (
    <div className="flex items-center gap-0.5 px-1 py-0.5 border border-b-0 border-gray-300 dark:border-gray-600 rounded-t bg-gray-50 dark:bg-gray-800">
      {ACTIONS.map((a) => (
        <button
          key={a.label}
          type="button"
          title={a.title}
          onMouseDown={(e) => {
            // prevent textarea blur before we read selection
            e.preventDefault();
            applyAction(a);
          }}
          className="flex items-center justify-center w-6 h-6 text-xs rounded text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
        >
          {a.icon}
        </button>
      ))}
    </div>
  );
}
