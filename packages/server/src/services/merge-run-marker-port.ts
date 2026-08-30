/**
 * The durable-marker side effects (#945), behind an injected port.
 *
 * **Default is a NO-OP; the real one is installed by the composition root**
 * (`startup/background-services.ts`, the `merge-run-reconciler` entry — both halves of the
 * feature wire up together), rather than a direct `merge-run.repository` import. Two reasons,
 * and the first is the load-bearing one: `merge-job.service.ts` is a pure in-memory registry
 * with no fixture-DB setup anywhere in its suites, so importing the repository would make every
 * `startMergeJob("ws-1")` in a unit test write to the process-global `db` — a test writing rows
 * into the real board database is a worse defect than the one being fixed. Second, it keeps that
 * module honest about what it is: the durable marker is a separate concern the registry merely
 * announces.
 *
 * It lives in its OWN module for that same reason — the split is what the doc comment above
 * already claimed was true, and the god-module gate (#889) is what forced it to become true when
 * #944's cache-invalidation hooks landed beside it.
 *
 * Both operations are fire-and-forget: the caller is a merge, and a marker that cannot be
 * written or cleared must never change what the merge does. A failed WRITE degrades to the
 * pre-#945 behaviour (a lost gate is silent again); a failed CLEAR leaves a stale row, which
 * the reconciler resolves against LIVE state rather than trusting the row on its own.
 */
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export interface MergeRunMarkerPort {
  set(workspaceId: string, values: { jobId: string; startedAt: string; source?: string | null; pid?: string | null }): Promise<void>;
  clear(workspaceId: string): Promise<void>;
}

const noopMarkerPort: MergeRunMarkerPort = {
  set: async () => {},
  clear: async () => {},
};

let markerPort: MergeRunMarkerPort = noopMarkerPort;

/** Install the durable-marker writer. Called once at startup; also the test seam. */
export function setMergeRunMarkerPort(port: MergeRunMarkerPort): void {
  markerPort = port;
}

/** Test seam: drop the installed port, so the default no-op is back in force. */
export function resetMergeRunMarkerPort(): void {
  markerPort = noopMarkerPort;
}

export function writeMergeRunMarker(
  workspaceId: string,
  values: { jobId: string; startedAt: string; source?: string | null },
): void {
  void markerPort
    .set(workspaceId, { ...values, pid: String(process.pid) })
    .catch((err) => {
      console.warn(
        `[workspace-merge] failed to persist the in-flight merge marker for workspace ${workspaceId} (non-fatal; `
          + `a restart mid-merge will be unrecoverable, #945):`,
        errorMessage(err),
      );
    });
}

export function clearMergeRunMarker(workspaceId: string): void {
  void markerPort.clear(workspaceId).catch((err) => {
    console.warn(
      `[workspace-merge] failed to clear the in-flight merge marker for workspace ${workspaceId} (non-fatal; `
        + `the reconciler re-checks live state before acting, #945):`,
      errorMessage(err),
    );
  });
}
