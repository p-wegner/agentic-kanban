// The worker-connect runbook's step shape (#774, #1089).
//
// Declared here — a pure lib module, no Node builtins, no drizzle — rather than in
// `types/api/`, because `server/src/cli/commands/worker.ts` is reached by the
// `agentic-kanban-worker` binary's isolation-tested import graph
// (`worker-cli-isolation.test.ts`), which only permits `@agentic-kanban/shared/lib/*` deep
// paths, never the `types` barrel. Both `buildWorkerConnectSteps` (that CLI module, consumed by
// `worker instructions` and `GET /api/workers/connect-info`) and the client's Connect tab
// (`WorkerConnectPanel.tsx`) import this ONE declaration instead of two hand-maintained copies.
export interface WorkerConnectStep {
  title: string;
  detail: string;
  /** Commands to run for this step, in order. Empty for check-only steps. */
  commands: string[];
  /** Where the step runs — worker machine, board machine, or either. */
  where: "worker" | "board" | "either";
}
