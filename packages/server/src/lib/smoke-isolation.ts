import { tmpdir } from "node:os";
import { createManagedTempDir, type ManagedTempDir } from "@agentic-kanban/shared/lib/temp-dir";
import { VERIFY_NEUTRALIZED_DB_LOCATION_ENV, VERIFY_NEUTRALIZED_LISTENER_ENV } from "./verify-env.js";

/**
 * Isolation for the pre-merge gate's smoke boot (#1095) — a second full board process spawned
 * next to the live one, purely to prove the dev command boots and the health URL answers.
 *
 * Same shape as the verify gate's own `AGENTIC_KANBAN_DIR`/neutralized-env isolation (#231):
 * without it, the smoke child inherits the live board's `KANBAN_DB_URL`/listener pins (or, absent
 * those, still resolves the operated `~/.agentic-kanban/kanban.db` home-fallback) and can reattach
 * a live agent session or run its own monitor cycle against the OPERATED database. Extracted to its
 * own module (rather than inlined in `pre-merge-gate.service.ts`) both for that parity with
 * `verify-env.ts` and because that file sits against the 1000-line god-module ceiling.
 */
export function createSmokeIsolation(): { env: Record<string, string>; disposeAndWarn: (context: string) => void } {
  let dir: ManagedTempDir;
  try {
    dir = createManagedTempDir("kanban-smoke-gate-");
  } catch {
    dir = { path: tmpdir(), dispose: () => true, disposeAsync: async () => true };
  }
  return {
    env: {
      AGENTIC_KANBAN_DIR: dir.path,
      ...VERIFY_NEUTRALIZED_LISTENER_ENV,
      ...VERIFY_NEUTRALIZED_DB_LOCATION_ENV,
      // Even against a throwaway DB, a monitor loop has nothing to reconcile on a boot that
      // exists only to be probed and torn down within seconds — see server-start.ts.
      KANBAN_SKIP_BACKGROUND_SERVICES: "1",
    },
    disposeAndWarn(context: string) {
      if (!dir.dispose()) {
        console.warn(`[pre-merge-gate] could not remove smoke gate data dir ${dir.path} for ${context} — a smoke child may still hold it as its cwd`);
      }
    },
  };
}
