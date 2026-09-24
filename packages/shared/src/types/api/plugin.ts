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
