import { useEffect, useState } from "react";
import { type Toast, subscribeToasts, showToast, dismissToast } from "../lib/toast.js";

// Re-export so existing component-side `import { showToast } from "../components/Toast.js"`
// call sites keep working. The store itself now lives in lib/toast.ts (leaf layer).
export { showToast };

const TOAST_TONE: Record<Toast["type"], string> = {
  error: "bg-red-600 text-white",
  success: "bg-green-600 text-white",
  warning: "bg-amber-500 text-white",
};

function ToastIcon({ type }: { type: Toast["type"] }) {
  if (type === "error") {
    return (
      <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <path d="m15 9-6 6M9 9l6 6" />
      </svg>
    );
  }
  if (type === "warning") {
    return (
      <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    );
  }
  return (
    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function ToastContainer() {
  const [currentToasts, setCurrentToasts] = useState<Toast[]>([]);

  useEffect(() => subscribeToasts(setCurrentToasts), []);

  if (currentToasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
      {currentToasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.onClick ? "button" : undefined}
          onClick={toast.onClick ? () => { toast.onClick?.(); dismissToast(toast.id); } : undefined}
          className={`px-4 py-2.5 rounded-md shadow-lg text-sm flex items-center gap-2 animate-in slide-in-from-right ${TOAST_TONE[toast.type]} ${toast.onClick ? "cursor-pointer hover:opacity-90" : ""}`}
          data-testid={`toast-${toast.type}`}
        >
          <ToastIcon type={toast.type} />
          <span>{toast.message}</span>
          {toast.sticky && (
            <button
              onClick={(e) => { e.stopPropagation(); dismissToast(toast.id); }}
              className="ml-1 shrink-0 opacity-80 hover:opacity-100"
              aria-label="Dismiss"
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
