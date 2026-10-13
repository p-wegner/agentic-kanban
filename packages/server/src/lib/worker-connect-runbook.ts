// The agent-readable connect runbook (#1442): ONE builder, three consumers — the page served
// at `GET /connect/<code>` on the fleet listener, its `?format=json` variant, and the Connect
// view's "Copy as Markdown" / "Download connect.md" (which receive the same text from the mint
// response). Pure strings, so all three are byte-identical for the same inputs.
//
// The node-only install commands come from `buildWorkerBootstrap` (the #1370 runbook) so the
// human flow and the agent flow cannot drift into two sets of commands.
import { buildWorkerBootstrap } from "@agentic-kanban/shared/lib/worker-bootstrap-steps";

export type ConnectOs = "windows" | "unix" | "wsl";
export const CONNECT_OS_VALUES: readonly ConnectOs[] = ["windows", "unix", "wsl"];

/** The operator's choices in the Connect view. All optional: each maps to exact `worker start` flags. */
export interface ConnectRunbookOptions {
  os: ConnectOs;
  workerName?: string;
  labels?: string[];
  /** `--providers`: which agent providers this machine offers (#1450). */
  providers?: string[];
  /** `--profiles`: which of the machine's logins it attests; absent = every one it finds (#1450). */
  profiles?: string[];
  maxConcurrency?: number;
  /** `--profile-alias` value, e.g. `default=anth` (#1379). */
  profileAlias?: string;
  /** `--toolchain-install` policy (#1371). */
  toolchainInstall?: "never" | "ask" | "auto";
  toolchainAllow?: string[];
  /** Extra `--board` URLs after the primary one (LAN first, tailnet fallback — #1337). */
  boardUrls?: string[];
}

export interface RunbookStep {
  id: string;
  title: string;
  detail: string;
  commands: string[];
  /** What a successful run looks like — the agent compares against this. */
  expect: string;
  /** An agent must not do this alone: the operator runs `humanCommand`, the agent then runs `check`. */
  needsHuman: boolean;
  humanCommand?: string;
  check?: string;
}

export interface ConnectRunbook {
  title: string;
  os: ConnectOs;
  steps: RunbookStep[];
  markdown: string;
}

export const CONNECT_PROGRESS_STEP_IDS_NOTE = "Use the step `id` values below when reporting progress.";

const SAFE_ARG = /^[A-Za-z0-9_.,=:@/\\-]+$/;

/** Quote a value for a shell command line: bare when plainly safe, double-quoted otherwise (inner quotes stripped). */
function arg(value: string): string {
  return SAFE_ARG.test(value) ? value : `"${value.replace(/["`$\\]/g, "")}"`;
}

/**
 * A comma list as ONE argument. PowerShell parses a bare `a,b` as an array and the worker receives "a b"
 * (#1453), so the Windows rendering single-quotes every list; POSIX shells keep the plain form.
 */
export function listArg(values: string[], quoteLists: boolean): string {
  const joined = values.join(",");
  return quoteLists && values.length > 1 ? `'${joined.replace(/'/g, "''")}'` : arg(joined);
}

/** The exact `worker start` flags for the operator's choices (never includes the pairing token — start reads the saved pairing). */
export function buildStartFlags(boardUrls: string[], o: ConnectRunbookOptions, quoteLists = false): string[] {
  const flags = [`--board ${listArg(boardUrls, quoteLists)}`];
  if (o.labels?.length) flags.push(`--labels ${listArg(o.labels, quoteLists)}`);
  if (o.providers?.length) flags.push(`--providers ${listArg(o.providers, quoteLists)}`);
  if (o.profiles?.length) flags.push(`--profiles ${listArg(o.profiles, quoteLists)}`);
  if (o.maxConcurrency && o.maxConcurrency > 0) flags.push(`--max-concurrency ${Math.floor(o.maxConcurrency)}`);
  if (o.profileAlias) flags.push(`--profile-alias ${arg(o.profileAlias)}`);
  if (o.toolchainInstall) flags.push(`--toolchain-install ${o.toolchainInstall}`);
  if (o.toolchainInstall === "auto" && o.toolchainAllow?.length) flags.push(`--toolchain-allow ${listArg(o.toolchainAllow, quoteLists)}`);
  flags.push("--auto-update");
  return flags;
}

export function buildConnectRunbook(input: {
  /** Primary fleet URL — what `--board` points at and where the progress callback goes. */
  fleetUrl: string;
  pairingToken: string;
  /** Connect code, only used to compose the progress URL. */
  code: string;
  options: ConnectRunbookOptions;
}): ConnectRunbook {
  const { pairingToken, code, options: o } = input;
  const base = input.fleetUrl.replace(/\/+$/, "");
  const boardUrls = [base, ...(o.boardUrls ?? []).map((u) => u.replace(/\/+$/, "")).filter((u) => u && u !== base)];
  const bootstrapOs = o.os === "windows" ? "windows" : "unix";
  const bootstrap = buildWorkerBootstrap(base, pairingToken, bootstrapOs);
  const [manifest, tarball, verify, install] = bootstrap.steps;
  const windows = o.os === "windows";
  const nameFlag = o.workerName ? ` --name ${arg(o.workerName)}` : "";
  const labelFlag = o.labels?.length ? ` --labels ${listArg(o.labels, windows)}` : "";
  const providerFlag = o.providers?.length ? ` --providers ${listArg(o.providers, windows)}` : "";
  const boardArg = listArg(boardUrls, windows);
  const startFlags = buildStartFlags(boardUrls, o, windows);
  const providerList = o.providers?.length ? o.providers : ["claude"];
  const profilesFlag = o.profiles?.length ? ` --profiles ${listArg(o.profiles, windows)}` : "";
  const startCommand = `agentic-kanban-worker start ${startFlags.join(" ")}${nameFlag}`;
  const progressUrl = `${base}/connect/${code}/progress`;

  const steps: RunbookStep[] = [];
  steps.push({
    id: "preconditions",
    title: "Check the preconditions",
    detail:
      "Run each command. If node is older than 22 or git is missing, stop and tell the operator — do not install a runtime " +
      "without asking. One provider CLI (claude or codex) must be present; `worker setup` can install it after asking.",
    commands: [
      "node --version",
      "git --version",
      "pnpm --version   # or: corepack --version",
      "claude --version   # or: codex --version",
    ],
    expect: "node v22 or newer; git 2.31 or newer; pnpm or corepack present; claude or codex present (a missing CLI is fixed by the setup step).",
    needsHuman: false,
  });
  steps.push(existingInstallStep(o.os, boardUrls[0]!));
  if (o.os === "wsl") {
    steps.push({
      id: "wsl-context",
      title: "Run inside the WSL distro",
      detail:
        "Every command in this runbook runs INSIDE the distro (a WSL shell), not from Windows. Keep the distro's disk off a Dev Drive " +
        "(a distro on D: hung on 2026-10-12). From Git Bash on Windows, set `MSYS_NO_PATHCONV=1` whenever you pass a Linux path to `wsl.exe`, " +
        "or MSYS rewrites it into a Windows path.",
      commands: ["uname -a", "echo $WSL_DISTRO_NAME"],
      expect: "A Linux kernel string mentioning microsoft/WSL, and a non-empty distro name.",
      needsHuman: false,
    });
  }
  if (windows) {
    steps.push({
      id: "retire-old-install",
      title: "Retire an older Windows worker install (tray / supervisor wrapper)",
      detail:
        "The older `tools/worker-windows` install (ak-worker-service.ps1 / ak-worker-run.ps1 / the tray) registered the SAME scheduled task " +
        "name `AgenticKanbanWorker` and a `AgenticKanbanWorkerTray` Startup shortcut, and its supervisor restarts a killed worker after up to 300 s — " +
        "so a second worker silently comes back minutes after this pairing and fights over the state file. List what exists first and tell the " +
        "operator what you found. If anything is there, stop and remove it (the runbook's own task below replaces it); if nothing is, move on. " +
        "Never delete the worker state file or the operator's claude config.",
      commands: [
        "Get-ScheduledTask -TaskName AgenticKanbanWorker -ErrorAction SilentlyContinue | Format-List TaskName, State",
        "Get-ChildItem \"$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\" -Filter 'AgenticKanbanWorkerTray*'",
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'ak-worker(-run|-service|-tray)?\\.ps1' } | Format-List ProcessId, CommandLine",
        "# only if something was listed and the operator agreed:",
        "Stop-ScheduledTask -TaskName AgenticKanbanWorker -ErrorAction SilentlyContinue",
        "Remove-Item \"$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\AgenticKanbanWorkerTray*\" -ErrorAction SilentlyContinue",
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'ak-worker(-run|-service|-tray)?\\.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
      ],
      expect: "No `ak-worker*.ps1` process, no AgenticKanbanWorkerTray shortcut; any old AgenticKanbanWorker task is stopped (the service step re-registers it).",
      needsHuman: false,
    });
  }
  steps.push(
    {
      id: "fetch-manifest",
      title: "Fetch the build manifest from the board",
      detail: "Note the `sha256` it reports. Waits up to 120 s while the board packs its current commit; HTTP 504 means retry this step, not continue.",
      commands: manifest.commands,
      expect: "JSON with a `sha256` field.",
      needsHuman: false,
    },
    {
      id: "download-build",
      title: "Download the worker build",
      detail: "The pairing token is NOT consumed by this download.",
      commands: tarball.commands,
      expect: "agentic-kanban-worker.tgz in the current directory, exit code 0.",
      needsHuman: false,
    },
    {
      id: "verify-build",
      title: "Verify the download",
      detail: "Compare the printed hash with the manifest `sha256`. If they differ, delete the file and stop.",
      commands: verify.commands,
      expect: "The printed hex equals the manifest sha256.",
      needsHuman: false,
    },
    {
      id: "install-build",
      title: "Install the worker build",
      detail: install.note ?? "Installs the `agentic-kanban-worker` command globally.",
      commands: install.commands,
      expect: "`agentic-kanban-worker --version` prints a version.",
      needsHuman: false,
    },
    {
      id: "setup-pair",
      title: "Set up and pair this machine",
      detail:
        "Checks git and the provider CLIs, creates the worker's own harness config dir (#1367) and pairs with the embedded " +
        "single-use token. Add `--yes` only if the operator allowed unattended installs; without it the command asks before installing " +
        "(with no terminal on stdin it asks nothing and skips). Setup checks `claude,codex` unless `--providers` says otherwise: on a " +
        "claude-only machine pass `--providers claude`, or doctor fails on the missing codex CLI. " +
        "A pairing state the board rejects as revoked (401) is copied to `<state>.revoked-<ms>`, dropped, and paired again with this token — the output says so (#1450).",
      commands: [`agentic-kanban-worker setup --board ${boardArg} --token ${pairingToken}${nameFlag}${labelFlag}${providerFlag}`],
      expect: "Output ends with the worker registered; a pairing state file exists. If it printed `moved it aside`, a stale revoked pairing was replaced.",
      needsHuman: false,
    },
    {
      id: "repo-check",
      title: "Check the cached clones and quarantine corrupt ones",
      detail:
        "`git fsck`s every cached clone under the worker's work root (#1417). A corrupt one is moved to `<work-root>/quarantine` (kept, not deleted) " +
        "so the next assignment re-clones it. Run this while no worker daemon is running — the existing-install step stopped any old one.",
      commands: ["agentic-kanban-worker repo-check --quarantine"],
      expect: "Exit code 0: either `every cached clone ... is intact` or one `QUARANTINED <project> -> <path>` line per corrupt clone.",
      needsHuman: false,
    },
    {
      id: "login",
      title: "Log the worker in to its provider (the operator does this)",
      detail:
        "Check the login BEFORE the service starts, so the daemon never comes up unable to run a session. " +
        "The login is interactive and holds the operator's credentials — an agent must not attempt or script it. This step is ALWAYS needed: " +
        "the worker's harness config dir is empty after setup. `--profile-alias default=<profile>` (in the start flags) only names that " +
        "harness dir under a profile name (#1379); it does NOT reuse the machine's default Claude login. Copying the default login in is " +
        "not offered: a copied OAuth session dies as soon as the source refreshes its token (seen with WSL).",
      commands: [],
      expect: "The check command prints a logged-in status for the provider.",
      needsHuman: true,
      humanCommand: `agentic-kanban-worker auth ${providerList[0] ?? "claude"}   # logs in inside the worker's own config dir`,
      check: `agentic-kanban-worker doctor --providers ${providerList.join(",")}${profilesFlag}`,
    },
    {
      id: "trust",
      title: "Accept the folder-trust dialog (the operator does this)",
      detail:
        "Claude Code asks once to trust each new repo directory (`hasTrustDialogAccepted`). The worker's checkouts have never been opened " +
        "interactively, so doctor reports this as `unknown`. Only the operator may accept it — never write the setting yourself.",
      commands: [],
      expect: "doctor's checkout-trust check no longer reports an untrusted work root.",
      needsHuman: true,
      humanCommand: "claude   # open it in the worker's repo directory, accept the trust prompt, then exit",
      check: "agentic-kanban-worker doctor",
    },
    {
      id: "doctor",
      title: "Run the worker doctor",
      detail: "Self-tests the whole chain to the board: fleet port, saved pairing, WebSocket upgrade, git transport, git, provider CLIs.",
      commands: [`agentic-kanban-worker doctor --board ${boardArg}${profilesFlag}`],
      expect:
        "Every check passes (exit code 0). `unknown` on the trust check is acceptable until the trust step is done; any `fail` is not. " +
        "The `attested profiles` line must list only the profiles the operator chose" +
        (o.profiles?.length ? ` (${o.profiles.join(", ")})` : " — without a `--profiles` choice it WARNs that every local login is attested; ask the operator which to offer") +
        ".",
      needsHuman: false,
    },
  );

  // Service step, per OS.
  if (windows) {
    const taskArgs = `-NoProfile -WindowStyle Hidden -Command "${startCommand.replace(/"/g, '\\"')}"`;
    steps.push({
      id: "service",
      title: "Start the worker as a scheduled task (no admin needed)",
      detail:
        "A scheduled task at logon, in the user's own session — not a Windows service, because the worker uses this user's provider " +
        "login. If registration is refused with an access error, tell the operator; do not elevate.",
      commands: [
        `$action = New-ScheduledTaskAction -Execute powershell.exe -Argument '${taskArgs.replace(/'/g, "''")}'`,
        "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME",
        "Register-ScheduledTask -TaskName AgenticKanbanWorker -Action $action -Trigger $trigger -Force",
        "Start-ScheduledTask -TaskName AgenticKanbanWorker",
      ],
      expect: "`Get-ScheduledTask AgenticKanbanWorker` shows state Running (or Ready then Running within seconds).",
      needsHuman: false,
    });
  } else {
    const unit = [
      "[Unit]",
      "Description=agentic-kanban worker",
      "After=network-online.target",
      "",
      "[Service]",
      `ExecStart=%h/.local/bin/agentic-kanban-worker start ${startFlags.join(" ")}${nameFlag}`,
      "Restart=on-failure",
      "RestartSec=10",
      "",
      "[Install]",
      "WantedBy=default.target",
    ].join("\\n");
    steps.push({
      id: "service",
      title: o.os === "wsl" ? "Start the worker as a systemd user unit (inside the distro)" : "Start the worker as a systemd user unit",
      detail:
        "Adjust ExecStart if `command -v agentic-kanban-worker` is somewhere else. " +
        (o.os === "wsl"
          ? "Needs systemd enabled in the distro (`/etc/wsl.conf` → `[boot] systemd=true`, then `wsl --shutdown` from Windows — ask the operator). Without systemd, run the start command under `nohup` and tell the operator it will not survive a distro restart."
          : "`loginctl enable-linger $USER` makes it survive logout; it may need the operator's authorisation."),
      commands: [
        "mkdir -p ~/.config/systemd/user",
        `printf '%b\\n' '${unit.replace(/'/g, "'\\''")}' > ~/.config/systemd/user/agentic-kanban-worker.service`,
        "systemctl --user daemon-reload",
        "systemctl --user enable --now agentic-kanban-worker",
      ],
      expect: "`systemctl --user is-active agentic-kanban-worker` prints `active`.",
      needsHuman: false,
    });
  }
  steps.push(verifyDaemonStep(o.os, boardUrls[0]!, startFlags));
  steps.push({
    id: "verify-online",
    title: "Confirm the worker is online",
    detail: "Give it ~15 seconds after starting. The operator's Connect view shows the same thing.",
    commands: [`agentic-kanban-worker doctor --board ${boardArg}`],
    expect: "Doctor passes and reports the heartbeat accepted; the board lists this worker as online.",
    needsHuman: false,
  });
  steps.push({
    id: "report",
    title: "Report back",
    detail: `Summarise to the operator: worker name, what passed, any step left for them. Progress reports (see below) are already on the board's Connect view.`,
    commands: [],
    expect: "The operator has a short written summary.",
    needsHuman: false,
  });

  const title = "Connect this machine as an agentic-kanban worker";
  const markdown = renderMarkdown({ title, os: o.os, steps, progressUrl, boardUrls, startCommand });
  return { title, os: o.os, steps, markdown };
}

/** #1450: find and stop an older worker install BEFORE installing — a live old scheduled task/service/daemon otherwise outlives `Register-ScheduledTask -Force`. */
function existingInstallStep(os: ConnectOs, board: string): RunbookStep {
  const commands =
    os === "windows"
      ? [
          "Get-ScheduledTask | Where-Object { $_.TaskName -match 'AgenticKanbanWorker|agentic-kanban-worker|ak-worker' -or (($_.Actions | ForEach-Object { \"$($_.Execute) $($_.Arguments)\" }) -join ' ') -match 'agentic-kanban-worker|ak-worker-service' } | Select-Object TaskName, State",
          "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'agentic-kanban-worker|ak-worker-service' -and $_.ProcessId -ne $PID } | Select-Object ProcessId, Name, CommandLine",
          "Test-Path \"$HOME\\.agentic-kanban\\worker\"   # the state dir an earlier install used",
          "agentic-kanban-worker status   # only if an old command exists: shows the running daemon's board, flags and state file",
        ]
      : [
          "systemctl --user list-units --all 'agentic-kanban-worker*' 'ak-worker*' --no-pager",
          "pgrep -af 'agentic-kanban-worker|ak-worker-service'",
          "crontab -l 2>/dev/null | grep -i 'agentic-kanban-worker\\|ak-worker'",
          "ls -d ~/.agentic-kanban/worker 2>/dev/null   # the state dir an earlier install used",
          "agentic-kanban-worker status   # only if an old command exists",
        ];
  const stop =
    os === "windows"
      ? "`Stop-ScheduledTask -TaskName <name>` then `Unregister-ScheduledTask -TaskName <name> -Confirm:$false` for each task found, then `Stop-Process -Id <pid>` for each leftover worker process (by PID only, never by image name)"
      : "`systemctl --user disable --now <unit>` for each unit found, remove a matching crontab line, then `kill <pid>` for each leftover worker process (by PID only, never by image name)";
  return {
    id: "existing-install",
    title: "Find and stop any older worker install",
    detail:
      "A worker installed earlier (same task name `AgenticKanbanWorker`, a wrapper such as `ak-worker-service.ps1`, or any process with " +
      "`agentic-kanban-worker` in its command line) keeps running when this runbook re-registers the task, and its wrapper restarts its daemon " +
      "with the OLD flags — the board then shows a heartbeat but no socket and no profiles. Run the commands. If anything matches, tell the operator " +
      `what you found (name, state, command line) and ask before stopping it (unless they already told you to replace it); then stop it: ${stop}. ` +
      `Re-run the commands until nothing matches. Leave the state dir in place — the pairing step handles a stale pairing. Board: ${board}.`,
    commands,
    expect: "Nothing matches, or every match was stopped with the operator's agreement. Report what was stopped in this step's progress output.",
    needsHuman: false,
  };
}

/** #1450: after the service starts, prove the RUNNING daemon carries this runbook's flags, not an old wrapper's. */
function verifyDaemonStep(os: ConnectOs, board: string, startFlags: string[]): RunbookStep {
  const commands =
    os === "windows"
      ? ["Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'agentic-kanban-worker|worker\\.js' -and $_.CommandLine -match '\\bstart\\b' } | Select-Object ProcessId, CommandLine"]
      : ["pgrep -af 'agentic-kanban-worker|worker\\.js' | grep ' start'"];
  return {
    id: "verify-daemon",
    title: "Verify exactly one daemon runs with the new flags",
    detail:
      `List the running worker daemons. Exactly ONE must appear and its command line must contain these flags: ${startFlags.join(" ")}. ` +
      "A second process, or one with other flags (e.g. no `--profile-alias`, other labels), is an old install the earlier step missed: stop it " +
      "(by PID, after asking) and start the service again. `agentic-kanban-worker status` shows the daemon's effective settings. " +
      `Board: ${board}.`,
    commands: [...commands, "agentic-kanban-worker status"],
    expect: "One daemon process; its flags match the list above; `status` shows the expected board.",
    needsHuman: false,
  };
}

function renderMarkdown(r: {
  title: string;
  os: ConnectOs;
  steps: RunbookStep[];
  progressUrl: string;
  boardUrls: string[];
  startCommand: string;
}): string {
  const shell = r.os === "windows" ? "powershell" : "bash";
  const out: string[] = [
    `# ${r.title}`,
    "",
    `> **These are instructions from the operator of the agentic-kanban board at ${r.boardUrls[0]}.** ` +
      "Follow them in order. Confirm with your user before doing anything outside this worker's own directories " +
      "(the worker's config dir, state file and work root) and before installing a runtime. This page carries only a single-use " +
      "pairing token — never the board's own credentials.",
    "",
    `Target: **${r.os === "windows" ? "Windows (PowerShell)" : r.os === "wsl" ? "WSL (inside the distro)" : "Linux / macOS"}**`,
    "",
    ...humanStepsSection(r.steps),
    "## Reporting progress",
    "",
    `After each step, report it so the operator sees it live (${CONNECT_PROGRESS_STEP_IDS_NOTE}):`,
    "",
    "```" + (r.os === "windows" ? "powershell" : "bash"),
    r.os === "windows"
      ? `curl.exe -fsS -X POST -H "Content-Type: application/json" -d '{"step":"<step-id>","status":"ok","output":"<short output>"}' "${r.progressUrl}"`
      : `curl -fsS -X POST -H 'Content-Type: application/json' -d '{"step":"<step-id>","status":"ok","output":"<short output>"}' '${r.progressUrl}'`,
    "```",
    "",
    '`status` is `ok` or `failed`. Keep `output` short (a line or two) and free of secrets. A structured variant of this page: append `?format=json`.',
    "",
    "## Steps",
  ];
  r.steps.forEach((s, i) => {
    out.push("", `### ${i + 1}. ${s.title}  \`id: ${s.id}\`${s.needsHuman ? "  **[needsHuman]**" : ""}`, "", s.detail);
    if (s.needsHuman) {
      out.push(
        "",
        "**Do not run this yourself.** Ask the operator to run, in their own terminal:",
        "",
        "```" + shell,
        s.humanCommand ?? "",
        "```",
        "",
        "Then run this check yourself:",
        "",
        "```" + shell,
        s.check ?? "",
        "```",
      );
    } else if (s.commands.length) {
      out.push("", "```" + shell, ...s.commands, "```");
    }
    out.push("", `**Expected:** ${s.expect}`);
  });
  out.push(
    "",
    "## Start flags in use",
    "",
    "```" + shell,
    r.startCommand,
    "```",
    "",
    "## Known traps",
    "",
    "- WSL: run everything inside the distro; keep distro disks off a Dev Drive (D: hung on 2026-10-12).",
    "- Git Bash: set `MSYS_NO_PATHCONV=1` when passing Linux paths to `wsl.exe`.",
    "- Claude Code: `hasTrustDialogAccepted` must be accepted by the operator for the worker's repo dir; the worker uses its own config dir (#1367); `--profile-alias default=<profile>` names the worker's own (initially empty) harness dir and does not reuse the default login: run `agentic-kanban-worker auth claude` (#1379, #1453).",
    "",
  );
  return out.join("\n");
}

/** #1450: say up front which steps need the operator, so the agent asks once rather than discovering them one by one. */
function humanStepsSection(steps: RunbookStep[]): string[] {
  const human = steps.filter((s) => s.needsHuman);
  if (!human.length) return [];
  return [
    "## What you will need from the operator",
    "",
    "Tell the operator now, so they are at the machine:",
    "",
    ...human.map((s) => `- **${s.title}** (\`id: ${s.id}\`)`),
    "- Approval before stopping an older worker install, if the `existing-install` step finds one.",
    "",
    "Finish every step that does not need them first; list in your final report which of these you asked for.",
    "",
  ];
}
