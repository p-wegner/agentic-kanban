/**
 * Stateless helpers for plugin iframe views — extracted from `plugin.service.ts` to keep it
 * under the 1000-line god-module ceiling (part of `verify_script`, so a breach fails the
 * pre-merge gate for every workspace on the board).
 *
 * Only the closure-FREE parts live here. The view lifecycle proper (startView/stopView and the
 * `viewChildren` process map) needs the service closure and lives in `plugin-views.service.ts`,
 * which imports these two helpers.
 */
import type { PluginManifest } from "@agentic-kanban/shared/lib/plugin-manifest";
import { PluginError } from "./plugin-errors.js";

/** Look up a declared view by id, or fail with a 404-shaped domain error. */
export function findView(manifest: PluginManifest, viewId: string) {
  const view = (manifest.views ?? []).find((v) => v.id === viewId);
  if (!view) throw new PluginError(`View "${viewId}" not found in plugin manifest`, "NOT_FOUND");
  return view;
}

/**
 * Single HTTP probe — never polls in a loop. Tries `healthPath` (default "/health") first;
 * a 404 there falls back to "/" so a plugin with no dedicated health endpoint still works.
 */
export async function probeHealth(port: number, healthPath = "/health"): Promise<boolean> {
  // readiness probe against a PLUGIN's supervised child view-server process
  // (spawnShellCommand in plugin.service.ts), not this board server — a genuinely separate
  // process on a dynamically allocated port with no in-process function to inject.
  // SELF-HTTP OK: see server/CLAUDE.md "Self-HTTP calls are an anti-pattern".
  const path = healthPath.startsWith("/") ? healthPath : `/${healthPath}`;
  try {
    // SELF-HTTP OK: a plugin's supervised child view-server, not this board server.
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1500) });
    if (res.status === 404 && path !== "/") {
      // SELF-HTTP OK: same child process, root-path fallback when it has no /health.
      const fallback = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
      return fallback.status < 500;
    }
    return res.status < 500;
  } catch {
    return false;
  }
}
