// Desktop notification integration — only active when running inside Tauri

let notificationReady = false;

async function initNotifications(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  // Detect Tauri environment
  if (!("__TAURI_INTERNALS__" in window)) return false;

  try {
    const { isPermissionGranted, requestPermission } = await import(
      "@tauri-apps/plugin-notification"
    );
    let granted = await isPermissionGranted();
    if (!granted) {
      const permission = await requestPermission();
      granted = permission === "granted";
    }
    notificationReady = granted;
    return granted;
  } catch {
    return false;
  }
}

export async function sendDesktopNotification(title: string, body: string) {
  if (!notificationReady) return;
  try {
    const { sendNotification } = await import(
      "@tauri-apps/plugin-notification"
    );
    sendNotification({ title, body });
  } catch {
    // Silently ignore — notifications are nice-to-have
  }
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Auto-initialize on import
initNotifications();

export { initNotifications };
