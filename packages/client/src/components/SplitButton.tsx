import { useRef, useEffect, useState } from "react";

export interface SplitButtonOption {
  label: string;
  onClick: () => void;
  title?: string;
}

interface SplitButtonProps {
  /** Label and handler for the primary (default) action */
  primary: SplitButtonOption;
  /** Additional actions shown in the dropdown */
  options: SplitButtonOption[];
  disabled?: boolean;
  /** Tailwind color classes, e.g. "bg-violet-600 hover:bg-violet-700 border-violet-500" */
  colorClasses?: string;
  className?: string;
  /** Open dropdown above the button instead of below */
  dropUp?: boolean;
}

/**
 * Split button: primary action on the left, chevron on the right opens a dropdown
 * with additional variants. Use when one action is the default and others are
 * accessed less frequently.
 *
 * See packages/client/CLAUDE.md for the usage pattern.
 */
export function SplitButton({
  primary,
  options,
  disabled = false,
  colorClasses = "bg-violet-600 hover:bg-violet-700 border-violet-500",
  className = "",
  dropUp = false,
}: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const base = `text-sm text-white px-3 py-1.5 disabled:opacity-50 ${colorClasses}`;

  return (
    <div ref={containerRef} className={`inline-flex relative ${className}`}>
      <button
        onClick={primary.onClick}
        disabled={disabled}
        title={primary.title}
        className={`${base} rounded-l`}
      >
        {primary.label}
      </button>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title="More options"
        className={`${base} rounded-r border-l px-2`}
      >
        ▾
      </button>
      {open && (
        <div
          className={`absolute ${dropUp ? "bottom-full mb-1" : "top-full mt-1"} left-0 w-52 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded shadow-lg z-10`}
        >
          {options.map((opt) => (
            <button
              key={opt.label}
              onClick={() => { setOpen(false); opt.onClick(); }}
              title={opt.title}
              className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 dark:text-gray-200"
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
