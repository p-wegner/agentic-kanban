// Pure, framework-agnostic toast store. Lives in lib/ (the client's leaf layer)
// so that hooks/ and lib/ services can fire toasts without importing up into the
// components/ layer. The React surface (ToastContainer) stays in components/Toast.tsx
// and subscribes here. showToast is also re-exported from components/Toast.tsx for
// back-compat with existing component-side imports.

export interface Toast {
  id: number;
  message: string;
  type: "error" | "success" | "warning";
  /** Sticky toasts stay until clicked or dismissed — for things that WAIT on the user (#300). */
  sticky?: boolean;
  /** Click handler (e.g. deep-link navigation); clicking also dismisses the toast. */
  onClick?: () => void;
}

let toastId = 0;
const listeners = new Set<(toasts: Toast[]) => void>();
let toasts: Toast[] = [];

function emit() {
  listeners.forEach((fn) => fn([...toasts]));
}

/** Subscribe to toast-list changes; returns an unsubscribe fn. Used by ToastContainer. */
export function subscribeToasts(fn: (toasts: Toast[]) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function showToast(
  message: string,
  type: "error" | "success" | "warning" = "error",
  opts?: { sticky?: boolean; onClick?: () => void },
) {
  const id = ++toastId;
  toasts = [...toasts, { id, message, type, sticky: opts?.sticky, onClick: opts?.onClick }];
  emit();
  if (!opts?.sticky) {
    setTimeout(() => dismissToast(id), 4000);
  }
}
