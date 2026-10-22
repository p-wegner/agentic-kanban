import { describe, expect, it, vi } from "vitest";
import type { WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import type { Database } from "../db/index.js";

vi.mock("../repositories/preferences.repository.js", () => ({
  getPreference: async () => null,
  setPreference: async () => {},
}));

import { createVerifyWorkerRunner, listActiveVerifyJobs } from "../services/verify-worker-runner.service.js";

const SHA = "b".repeat(40);

describe("verify_progress keeps no stale filesTotal (#1669)", () => {
  it("a count frame without filesTotal clears the total; done never exceeds a shown total", async () => {
    const listeners = new Set<(workerId: string, m: WorkerToBoardMessage) => void>();
    const connections = {
      isConnected: () => true,
      send: () => true,
      onMessage: (l: (workerId: string, m: WorkerToBoardMessage) => void) => { listeners.add(l); return () => listeners.delete(l); },
      onDisconnect: () => () => {},
    };
    const registry = { listWorkersView: async () => [{ id: "w1", name: "w", effectiveStatus: "online", verify: { slots: 1, freeSlots: 1, ramGb: 32, jobIds: [] }, capacity: { freeRamGb: 20, spareCores: 8, thrashing: "none" } }] };
    const runner = createVerifyWorkerRunner({
      database: {} as Database,
      fleet: { connections, registry } as never,
      issueGitAuth: async () => ({ gitPort: 9, gitToken: "t" }),
      readSetupScript: async () => null,
    });
    const ctl = new AbortController();
    const running = runner.run({ requestId: "job-x", workerId: "w1", sha: SHA, tier: "full", kind: "rc-sweep", command: "pnpm verify", workingDir: "/repo", projectId: "p1", branch: "rc/1", timeoutMs: 1000, signal: ctl.signal } as never);
    await vi.waitFor(() => expect(listActiveVerifyJobs()).toHaveLength(1));
    const emit = (m: Record<string, unknown>) => { for (const l of listeners) l("w1", { type: "verify_progress", jobId: "job-x", stage: "verify", ...m } as WorkerToBoardMessage); };
    const job = () => listActiveVerifyJobs()[0]!;

    emit({ filesDone: 5, filesTotal: 20 });
    expect(job()).toMatchObject({ filesDone: 5, filesTotal: 20 });
    emit({ stage: "verify" });
    expect(job()).toMatchObject({ filesDone: 5, filesTotal: 20 }); // a stage-only frame keeps both
    emit({ filesDone: 30 });
    expect(job().filesDone).toBe(30);
    expect(job().filesTotal).toBeUndefined();
    emit({ filesDone: 40, filesTotal: 10 }); // inconsistent frame: drop the total rather than show 40/10
    expect(job().filesTotal).toBeUndefined();

    ctl.abort();
    await running;
  });
});
