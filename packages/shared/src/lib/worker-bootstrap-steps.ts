// The node-only worker bootstrap (#1370): the exact commands for a machine that has only node.
//
// ONE builder, two renderers. `worker pair` (CLI) prints `renderBootstrapText`; `GET
// /api/workers/connect-info` hands the structured `WorkerBootstrap` to the Connect tab, which
// renders each command with a copy button. Both come from here, so the CLI and the UI cannot
// drift into two different runbooks. Pure strings: no node builtins, safe for the client bundle
// and for the standalone worker binary's import graph.

export type BootstrapOs = "windows" | "unix";

export interface BootstrapStep {
  title: string;
  /** Copyable commands, in order. The pairing token is already filled in. */
  commands: string[];
  /** A caveat for this step (shown under the commands). */
  note?: string;
}

export interface WorkerBootstrap {
  os: BootstrapOs;
  /** Label for the OS switch. */
  label: string;
  intro: string[];
  steps: BootstrapStep[];
  footer: string[];
}

/** The placeholder the connect-info route embeds; the Connect tab swaps in the minted token. */
export const BOOTSTRAP_TOKEN_PLACEHOLDER = "<pairing-token>";

export const BOOTSTRAP_OS_LABEL: Record<BootstrapOs, string> = {
  windows: "Windows (PowerShell)",
  unix: "Linux / macOS",
};

export function buildWorkerBootstrap(fleetUrl: string, pairingToken: string, os: BootstrapOs = "windows"): WorkerBootstrap {
  const base = fleetUrl.replace(/\/+$/, "");
  const curl = os === "windows" ? "curl.exe" : "curl";
  const intro =
    os === "windows"
      ? [
          "On a FRESH machine with only node installed (no worker yet):",
          "  (The commands are for Windows: curl.exe ships with Windows 10+ and also works in PowerShell 7, while in",
          "   Windows PowerShell 5.1 plain `curl` is Invoke-WebRequest and rejects these flags.)",
        ]
      : ["On a FRESH Linux/macOS machine with only node installed (no worker yet):"];
  const steps: BootstrapStep[] = [
    {
      title: `Fetch the build manifest (note "sha256"; waits up to 120 s while the board packs this commit):`,
      commands: [`${curl} -fsS -H "Authorization: Bearer ${pairingToken}" "${base}/api/workers/build?wait=120"`],
    },
    {
      title: "Download the tarball (the pairing token is NOT consumed by this):",
      commands: [
        `${curl} -fL -H "Authorization: Bearer ${pairingToken}" -o agentic-kanban-worker.tgz "${base}/api/workers/build/tarball?wait=120"`,
      ],
    },
    {
      title: "Verify it equals the sha256 from step 1:",
      commands: [
        `node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('agentic-kanban-worker.tgz')).digest('hex'))"`,
      ],
    },
    {
      title: "Install:",
      commands: ["npm i -g ./agentic-kanban-worker.tgz"],
      ...(os === "unix"
        ? {
            note:
              "If npm fails with EACCES (a root-owned global prefix), install to a user prefix instead: " +
              "`npm config set prefix \"$HOME/.local\"`, add `$HOME/.local/bin` to PATH, then re-run the install.",
          }
        : {}),
    },
    {
      title: "Set up and pair (installs git/claude/codex only after asking; add --yes for unattended, --no-install to only check):",
      commands: [`agentic-kanban-worker setup --board ${base} --token ${pairingToken}`],
    },
    {
      title: "Then run the daemon (keeps itself on the board's build):",
      commands: [`agentic-kanban-worker start --board ${base} --auto-update`],
    },
  ];
  return {
    os,
    label: BOOTSTRAP_OS_LABEL[os],
    intro,
    steps,
    footer: [
      "(Steps 1 and 2 wait for the board to finish packing its build; if it takes longer than 120 s they fail with",
      " HTTP 504 and a non-zero exit - stop there and re-run that step, do not continue to step 3.)",
    ],
  };
}

/** The CLI rendering of {@link buildWorkerBootstrap}. */
export function renderBootstrapText(bootstrap: WorkerBootstrap): string {
  const lines = [...bootstrap.intro];
  bootstrap.steps.forEach((step, i) => {
    lines.push(`  ${i + 1}. ${step.title}`);
    for (const command of step.commands) lines.push(`       ${command}`);
    if (step.note) lines.push(`     ${step.note}`);
  });
  lines.push(...bootstrap.footer);
  return lines.join("\n");
}
