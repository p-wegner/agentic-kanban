/**
 * The board's overlay panels, in one table (#588).
 *
 * Board VIEWS have had a registry since #446 (`lib/viewRegistry.tsx`, 27 ids, guarded by the
 * `viewTabs` collision test). Panels had none: 19 of them were wired by hand as parallel
 * `showX: boolean` + `setShowX` + `onCloseX` quadruplets — 141 per-panel declarations in
 * `useBoardPanels.ts` alone — and adding one meant editing four files.
 *
 * The registry is the id list plus the CLOSE ORDER, because the order is a real behaviour:
 * Escape closes the topmost panel, and "topmost" was previously encoded as the sequence of
 * an `if`-chain, where it could not be read without tracing every branch.
 *
 * Pure data with no React import, so it stays in `lib/` per #589's rule.
 */

/**
 * Close order for Escape — FIRST entry wins. Modal-most panels come first: the command
 * palette sits above everything, and the picker/help overlays above the workspace lists.
 *
 * Panels absent from this list are deliberately NOT Escape-closable here — `settings`,
 * `mergeQueue`, `transcriptSearch` and `startWorkspacePicker` own their own dismissal
 * (their components handle Escape, or they close on an action). That was true before this
 * table and is now visible instead of implied by an omission from an if-chain.
 */
export const PANEL_CLOSE_ORDER = [
  "commandPalette",
  "allWorkspaces",
  "liveActivityTicker",
  "launchFailures",
  "cleanupQueue",
  "fileContention",
  "workerFleet",
  "multiRepoMonitor",
  "worktreeOverview",
  "shortcutHelp",
  "quickTasks",
  "runQueueForecast",
  "codemod",
  "projectHealth",
  "timeReport",
] as const;

/** Every panel the board can open. */
export const PANEL_IDS = [
  "settings",
  "quickTasks",
  "mergeQueue",
  "runQueueForecast",
  "codemod",
  "worktreeOverview",
  "allWorkspaces",
  "launchFailures",
  "cleanupQueue",
  "fileContention",
  "workerFleet",
  "multiRepoMonitor",
  "transcriptSearch",
  "projectHealth",
  "timeReport",
  "commandPalette",
  "shortcutHelp",
  "liveActivityTicker",
  "startWorkspacePicker",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

/** `settings` -> `showSettings`. The prop names predate the registry and are unchanged. */
export type PanelShowProp<K extends string> = `show${Capitalize<K>}`;
/** `settings` -> `onCloseSettings`. */
export type PanelCloseProp<K extends string> = `onClose${Capitalize<K>}`;

export const showPropFor = (id: PanelId): string => `show${id[0].toUpperCase()}${id.slice(1)}`;
export const closePropFor = (id: PanelId): string => `onClose${id[0].toUpperCase()}${id.slice(1)}`;
