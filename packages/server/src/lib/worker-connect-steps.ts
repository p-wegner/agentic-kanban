import type { WorkerConnectStep } from "@agentic-kanban/shared/lib/worker-connect-steps";

/**
 * The connect runbook, as data. Exported so `worker instructions --json`, the
 * `fleet-worker` agent skill, the docs, and the Connect tab (`GET /api/workers/connect-info`)
 * all render the SAME steps instead of copies that drift.
 *
 * Lives in `server/src/lib/` (pure server-lib), not `cli/commands/worker.ts`, so that
 * `routes/workers.ts` (a `server-route`) does not need to import `server-cli` — the
 * pattern-language spec forbids that edge (arch loop, ak-1094). `cli/commands/worker.ts`
 * re-imports this same function rather than defining it, so `worker instructions` and
 * `GET /api/workers/connect-info` still render byte-identical steps.
 */
export function buildWorkerConnectSteps(boardUrl: string, pairingToken: string): WorkerConnectStep[] {
  return [
    {
      title: "Verify the prerequisites on this machine",
      where: "worker",
      detail:
        "A worker runs agents with ITS OWN credentials — the board never sends any. So the provider CLI must be " +
        "installed here and already logged in, and git must be on PATH. No board checkout is needed and the " +
        "board's database is never accessed: the worker speaks only HTTP/WebSocket.",
      commands: ["git --version", "claude --version   # or: codex --version / copilot --version"],
    },
    {
      title: "Get the worker binary onto this machine",
      where: "worker",
      detail:
        "Do NOT assume `npm i -g agentic-kanban` provides it. The published package can lag this tree: 0.1.9 on " +
        "the registry was released BEFORE the worker fleet landed, so its bin map has no `agentic-kanban-worker` " +
        "key at all — the install succeeds and the binary is simply absent. Check the registry before relying on " +
        "it (`npm view agentic-kanban bin`); if the worker key is missing, use the tarball fast track instead: on " +
        "the BOARD machine run `node scripts/pack-worker.mjs`, which builds, refuses to pack a tarball whose bin " +
        "map lacks the worker, and stamps a `<version>-dev.<sha>` prerelease so npm can never serve a cached " +
        "same-version copy in its place. Copy the tarball here and install it by path. `--blob` additionally " +
        "puts it on an ACP relay and prints a ref, for a machine you cannot copy files to directly. " +
        "Verify the install: `--version` reports the version from the installed manifest, so it must echo the " +
        "tarball's `-dev.<sha>` stamp back. A bare `0.0.1` means an old build (the version used to be hardcoded); " +
        "the registry's plain `0.1.9` means npm served a cached copy instead of your file. " +
        "An ERESOLVE peer warning about `zod` on install is EXPECTED and harmless: the agent SDK declares a " +
        "`zod ^4` peer while this tree pins 3.x, but that peer is type-level only (no runtime file in the SDK " +
        "imports zod) — see the note in pnpm-workspace.yaml. It does not affect the worker, which does not bundle " +
        "the SDK at all.",
      commands: [
        "npm view agentic-kanban bin   # does the published bin map have agentic-kanban-worker?",
        "npm i -g <path-to-agentic-kanban-*.tgz>",
        "agentic-kanban-worker --version        # must print the tarball's version, not 0.0.1",
        "npm ls -g --depth 0 agentic-kanban     # cross-check: catches npm serving a cached copy",
      ],
    },
    {
      title: "Confirm the board is reachable from here",
      where: "worker",
      detail:
        `Anything other than a connection error means the board is reachable. Use the board's FLEET port here, not ` +
        `its API port — a remote worker never talks to the board API. If this refuses to connect, the board is ` +
        `not exposing a fleet listener yet (see the board-side note below).`,
      commands: [`curl -s -o /dev/null -w "%{http_code}\\n" ${boardUrl}/api/health`],
    },
    {
      title: "Mint a pairing token (on the board machine)",
      where: "board",
      detail:
        "Pairing tokens are single-use and expire in 10 minutes. Mint one on the board host (the mint endpoint " +
        "rides the board's loopback trust), or use the Runners view's Connect tab: command palette → \"Runners\" → " +
        "Connect → Mint token. Copy the token to this machine.",
      commands: ["agentic-kanban worker pair"],
    },
    {
      title: "Start the worker daemon",
      where: "worker",
      detail:
        "Registers with the board, then holds a WebSocket open for assignments. The pairing token is exchanged for " +
        "a per-worker token saved in ~/.agentic-kanban/worker-state.json, so later runs need no --token. Set " +
        "--labels to advertise capabilities a project can require, --providers to declare which agent CLIs work " +
        "here, and --max-concurrency for how many sessions this machine should take. Runs in the foreground until " +
        "Ctrl+C. `agentic-kanban-worker` is the standalone binary for worker machines — it loads only the " +
        "daemon and never touches a database; on a machine that also runs the board, `agentic-kanban " +
        "worker start` is equivalent.",
      commands: [
        `agentic-kanban-worker start --board ${boardUrl} --token ${pairingToken} \\`,
        `  --name "$(hostname)" --labels docker,linux --providers claude --max-concurrency 2`,
      ],
    },
    {
      title: "Verify the board sees this worker",
      where: "either",
      detail:
        "The worker should be listed as `online` with the labels and capacity you passed. It reads `offline` if its " +
        "heartbeat is older than 90s — that means the daemon died or lost the connection.",
      commands: [`agentic-kanban-worker list --board ${boardUrl}`],
    },
    {
      title: "Opt a project into dispatching work here",
      where: "board",
      detail:
        "Registration alone does not route work. A project opts in with worker_dispatch_<projectId>; it can require " +
        "capabilities with worker_labels_<projectId>, and worker_dispatch_strict_<projectId> forbids the silent " +
        "fallback to running on the board host (the monitor then reports the no_available_worker skip reason " +
        "instead). Get the project id from `agentic-kanban list`.",
      commands: [
        "agentic-kanban preferences set worker_dispatch_<projectId> true",
        "agentic-kanban preferences set worker_labels_<projectId> docker,linux    # optional",
        "agentic-kanban preferences set worker_dispatch_strict_<projectId> true   # optional",
      ],
    },
  ];
}
