// Pure, framework-agnostic toast store. Lives in lib/ (the client's leaf layer)
// so that hooks/ and lib/ services can fire toasts without importing up into the
// components/ layer. The React surface (ToastContainer) stays in components/Toast.tsx
// and subscribes here. showToast is also re-exported from components/Toast.tsx for
// back-compat with existing component-side imports.

export interface Toast {
  id: number;
  message: string;
  type: "error" | "success";
}

let toastId = 0;
const listeners = new Set<(toasts: Toast[]) => void>();
let toasts: Toast[] = [];

/** Subscribe to toast-list changes; returns an unsubscribe fn. Used by ToastContainer. */
export function subscribeToasts(fn: (toasts: Toast[]) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function showToast(message: string, type: "error" | "success" = "error") {
  const id = ++toastId;
  toasts = [...toasts, { id, message, type }];
  listeners.forEach((fn) => fn([...toasts]));
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    listeners.forEach((fn) => fn([...toasts]));
  }, 4000);
}
