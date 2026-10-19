import type { SkillListing } from "../../lib/plugin-skill-listing.js";

/**
 * Plugin wire types (#569).
 *
 * `PluginOwner` — which installed plugin a view/loop/script/skill row belongs to — was
 * declared twice: once in the client's `PluginActionPanes.tsx` and once (as an inline
 * object literal, repeated at every projection site) on the server. The server side is
 * now built in ONE place (`services/plugin-enabled.ts`, #552), so the shape belongs
 * here where both halves can import the same declaration.
 */
export interface PluginOwner {
  /** Plugin DB row id — the `:id` segment of the plugin routes. */
  pluginId: string;
  /** The manifest's own slug (`plugin_id`), which keys preferences and unit ids. */
  pluginSlug: string;
  pluginName: string;
}

/**
 * A plugin script's settled result — the server's `runPluginCommand` return shape
 * (`services/plugin-exec.ts`), returned verbatim as the non-streaming `POST
 * .../scripts/:name/run` response body and as the `stage: "done"` SSE event (#1229).
 */
export interface PluginScriptRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when stdout exceeded the diagnostics cap and its FRONT was discarded. */
  stdoutTruncated: boolean;
}

/** `POST /api/plugins/:id/sync/test-connection` (#1275): the `bootstrap` run, secrets masked. */
export interface PluginSyncConnectionTest {
  ok: boolean;
  error?: string;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** One run's structured facts (#1625) - the single contract `parseRunSummary` normalizes into. */
export interface PluginSyncRunSummary {
  /** The script's own step (`pull`, `push`, `profile`, ...). */
  step?: string;
  counts?: {
    created?: number;
    updated?: number;
    skipped?: number;
    conflicted?: number;
    applied?: number;
    failed?: number;
    outOfScope?: number;
  };
  issues?: Array<{ externalKey: string; externalUrl?: string; localIssueNumber?: number; status?: string }>;
  conflicts?: Array<{ externalKey: string; reason: string; externalUrl?: string }>;
  failures?: Array<{ externalKey: string; reason: string; kind?: string; externalUrl?: string }>;
}

export interface PluginSyncRunRecord {
  direction: "pull" | "push";
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  error?: string;
  code?: number | null;
  timedOut?: boolean;
  /** Set when the board's schedule (not a person) started the run. */
  scheduled?: boolean;
  summary?: PluginSyncRunSummary;
}

/** `GET /api/plugins/:id/sync/status` (#1625): last run per direction, outbox length, schedule. */
export interface PluginSyncStatusView {
  provider: string | null;
  configured: boolean;
  /** The most recent run of either direction. */
  lastRun: PluginSyncRunRecord | null;
  lastRuns: { pull: PluginSyncRunRecord | null; push: PluginSyncRunRecord | null };
  /** Queued, not-yet-pushed entries in the plugin's outbox; null when it cannot be read. */
  outboxLength: number | null;
  /** Minutes between scheduled runs per direction; 0 = off. */
  schedule: { pullEveryMinutes: number; pushEveryMinutes: number };
}

/**
 * Periodic progress snapshot for a still-running plugin script (#1229) — elapsed time, the
 * streamed output tail so far, and the timeout limit, so a caller can show both before the
 * run ever hits it. Sent as the `stage: "progress"` SSE event from `.../scripts/:name/run?stream=1`.
 */
export interface PluginScriptRunProgress {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  elapsedMs: number;
  timeoutMs: number;
}

/** The SSE event shape `.../scripts/:name/run?stream=1` sends, one `data:` line per event. */
export type PluginScriptRunEvent =
  | ({ stage: "progress" } & PluginScriptRunProgress)
  | ({ stage: "done" } & PluginScriptRunResult)
  | { stage: "error"; message: string };

/**
 * A per-project resolved listing mode for one plugin-declared skill (#1252 Plugins-view
 * picker) — one entry per `GET /api/plugins?projectId=` row's `skillListings`, and the shape
 * `PluginSkillListingSelector` renders.
 */
export interface ResolvedSkillListing {
  name: string;
  mode: SkillListing;
  /** Where the resolved mode came from — for display, not decision-making. */
  source: "project" | "manifest" | "default";
  /** The manifest author's own hint, if any (undefined = no opinion declared). */
  manifestHint: SkillListing | undefined;
  /** `description.length` — a rough per-turn token-cost proxy for listing this skill "on". */
  descriptionSize: number;
}
