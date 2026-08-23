/**
 * `worker doctor` — the connectivity self-test (#774, remaining #755 item 4).
 *
 * WHAT WAS MISSING: nothing checked the whole chain from the worker side. Runbook step 3 of
 * `docs/worker-fleet.md` is still a raw `curl -o /dev/null -w "%{http_code}"` against
 * `/health`, which proves one hop of five: it says nothing about whether the saved bearer
 * token still authenticates, whether the WebSocket upgrade survives whatever sits between
 * the two machines, whether the git transport port is reachable, or whether the provider CLI
 * on this machine is logged in — and that last one is the failure the board CANNOT diagnose,
 * because the board deliberately sends no credentials (decision 012).
 *
 * WHY IT IS TWO COMMANDS, NOT ONE. `docs/worker-fleet.md` §1 is explicit that a worker
 * machine "genuinely cannot ask the board how it looks from there": every owner route
 * (`GET /api/workers` included) is mounted only on the loopback board app, so a worker
 * pointed at the fleet port gets a 404 and pointed at the API port cannot connect at all.
 * A single command claiming to check both ends would therefore have to lie about one of
 * them. So:
 *
 *   - `worker doctor`        runs ON THE WORKER MACHINE  — the five hops it can prove.
 *   - `worker doctor-board`  runs ON THE BOARD MACHINE   — what the board sees of the fleet.
 *
 * Each check reports `pass` / `fail` / `skip` / `unknown` and never dresses an
 * indeterminate result as a pass. `unknown` is a real outcome here: an OAuth login can be
 * checked by file presence but not proven without spending a request.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

export type CheckStatus = "pass" | "fail" | "skip" | "unknown";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do about a fail. Omitted when there is nothing actionable. */
  remedy?: string;
}

export interface DoctorReport {
  /** Which side of the fleet this report was produced from. */
  side: "worker" | "board";
  boardUrl: string;
  checks: DoctorCheck[];
  ok: boolean;
}

/**
 * The files that mean "this provider is logged in on THIS machine".
 *
 * Duplicated from the auth-rotation ring configs (`claude-subscription-ring.ts`
 * `authFiles: [".credentials.json", "settings.json"]`, `codex-license-ring.ts`
 * `authFiles: ["auth.json"]`) rather than imported, because those modules reach the
 * database and this file is part of the standalone worker binary, which "never opens or
 * creates a database" (docs/worker-fleet.md §3). The duplication is PINNED:
 * `worker-doctor-auth-parity.test.ts` reads those two source files and fails if either
 * list changes without this one.
 */
export const PROVIDER_AUTH_FILES: Record<string, { dir: string; files: string[]; loginCommand: string }> = {
  claude: { dir: ".claude", files: [".credentials.json", "settings.json"], loginCommand: "claude /login" },
  codex: { dir: ".codex", files: ["auth.json"], loginCommand: "codex login" },
};

function ok(name: string, detail: string): DoctorCheck {
  return { name, status: "pass", detail };
}
function bad(name: string, detail: string, remedy?: string): DoctorCheck {
  return remedy === undefined ? { name, status: "fail", detail } : { name, status: "fail", detail, remedy };
}

/** Run a command and report whether it exists and what it printed. Never throws. */
export function probeCommand(
  command: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<{ found: boolean; code: number | null; output: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      // windowsHide: this must never flash a console window — the board's own rule, and a
      // doctor run from a Windows scheduled task would otherwise pop one per provider.
      { timeout: timeoutMs, windowsHide: true, shell: false },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ found: false, code: null, output });
          return;
        }
        const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
        resolve({ found: true, code, output });
      },
    );
  });
}

/** Any HTTP answer proves the listener is up; only a transport error is a failure. */
async function probeHttp(url: string, init?: RequestInit): Promise<{ reachable: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(url, init);
    return { reachable: true, status: res.status };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface SavedIdentity {
  workerId: string;
  workerToken: string;
  name: string;
}

/**
 * The pairing this machine already holds for `boardUrl`, from the worker state file.
 *
 * Read directly rather than through the daemon so the doctor can run while the daemon is
 * NOT running — which is the case an operator reaches for it in.
 */
export function readSavedIdentity(stateFile: string, boardUrl: string): SavedIdentity | null {
  try {
    if (!existsSync(stateFile)) return null;
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as {
      boards?: Record<string, SavedIdentity>;
    };
    const entry = parsed.boards?.[boardUrl.replace(/\/+$/, "")];
    return entry?.workerId && entry.workerToken ? entry : null;
  } catch {
    return null;
  }
}

/** Check 1 — is the fleet listener answering at all? */
async function checkReachable(boardUrl: string): Promise<DoctorCheck> {
  // The fleet listener answers `/health` AND `/api/health` unauthenticated on purpose, so
  // one probe works against either port (docs §1).
  const probe = await probeHttp(`${boardUrl}/health`);
  if (!probe.reachable) {
    return bad(
      "fleet port reachable",
      `${boardUrl}/health could not be reached: ${probe.error}`,
      "Check the host/port, that KANBAN_FLEET_PORT is set on the board, and that KANBAN_FLEET_HOST " +
        "names an interface this machine can route to (absent = every interface).",
    );
  }
  return ok("fleet port reachable", `${boardUrl}/health answered ${probe.status}`);
}

/** Check 2 — does the pairing this machine holds still authenticate? */
async function checkHeartbeat(boardUrl: string, identity: SavedIdentity | null): Promise<DoctorCheck> {
  if (!identity) {
    return {
      name: "saved pairing authenticates",
      status: "skip",
      detail: "no pairing saved for this board — nothing to authenticate yet",
      remedy: `Mint a token on the board (agentic-kanban worker pair) and run: worker start --board ${boardUrl} --token <token>`,
    };
  }
  const probe = await probeHttp(`${boardUrl}/api/workers/${identity.workerId}/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${identity.workerToken}` },
    // No `protocolVersion` key: the registry treats its ABSENCE as "declared nothing" and
    // skips the version judgement, so a doctor run can never be refused for skew it is not
    // testing. Skew is what check 3 (the socket) and the board's own logs surface.
    body: JSON.stringify({}),
  });
  if (!probe.reachable) {
    return bad("saved pairing authenticates", `heartbeat could not be reached: ${probe.error}`);
  }
  if (probe.status === 401) {
    return bad(
      "saved pairing authenticates",
      `the board rejected this machine's bearer token (401) for worker ${identity.workerId}`,
      "The worker was revoked, or the board's DB was replaced. Revoke it on the board and re-pair with a fresh --token.",
    );
  }
  if (probe.status === 409) {
    return bad(
      "saved pairing authenticates",
      "protocol version mismatch (409) — the token is fine, the build is not",
      "Upgrade this machine's agentic-kanban worker to match the board's protocol version.",
    );
  }
  if (probe.status !== 200) {
    return bad("saved pairing authenticates", `heartbeat answered ${probe.status}, expected 200`);
  }
  return ok("saved pairing authenticates", `worker ${identity.workerId} heartbeat accepted (200)`);
}

/**
 * Check 3 — does the WebSocket upgrade survive whatever sits between the machines?
 *
 * The one hop `curl /health` cannot cover, and the one most likely to be broken by
 * something in the middle: a proxy that does not forward `Upgrade`, or a tunnel that
 * answers HTTP fine and drops the socket.
 */
export function checkWebSocket(
  boardUrl: string,
  identity: SavedIdentity | null,
  timeoutMs = 10_000,
): Promise<DoctorCheck> {
  if (!identity) {
    return Promise.resolve({
      name: "websocket upgrade",
      status: "skip",
      detail: "no pairing saved — the socket is authenticated per worker, so there is nothing to open",
    });
  }
  const wsUrl = `${boardUrl.replace(/^http/, "ws")}/ws/workers/${identity.workerId}`;
  return new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${identity.workerToken}` } });
    const finish = (check: DoctorCheck): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Close it immediately: the board evicts a second connection for the same workerId,
      // so a doctor run that LEFT its socket open would knock the real daemon offline.
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      resolve(check);
    };
    const timer = setTimeout(
      () =>
        finish(
          bad(
            "websocket upgrade",
            `no open within ${timeoutMs} ms at ${wsUrl}`,
            "Something between the machines is not forwarding the Upgrade header. A path-based reverse " +
              "proxy in front of the fleet port is the usual cause (docs/worker-fleet.md §8).",
          ),
        ),
      timeoutMs,
    );
    socket.on("open", () => finish(ok("websocket upgrade", `${wsUrl} accepted the upgrade`)));
    socket.on("error", (err: Error) =>
      finish(bad("websocket upgrade", `${wsUrl} failed: ${err.message}`)),
    );
    socket.on("unexpected-response", (_req: unknown, res: { statusCode?: number }) =>
      finish(
        bad(
          "websocket upgrade",
          `${wsUrl} answered HTTP ${res.statusCode ?? "?"} instead of upgrading`,
          res.statusCode === 401
            ? "The bearer token was rejected — re-pair this machine."
            : "The fleet listener does not serve this path; check the port.",
        ),
      ),
    );
  });
}

/**
 * Check 4 — is the git transport reachable?
 *
 * Only probeable when the operator names the port: the worker learns the git port from the
 * BOARD, per assignment (`composeGitUrl`), so a doctor with no assignment in hand does not
 * know it. Reporting `skip` with the reason beats guessing 3002 and calling a wrong answer
 * a failure.
 */
async function checkGitTransport(boardUrl: string, gitPort?: number): Promise<DoctorCheck> {
  if (!gitPort) {
    return {
      name: "git transport reachable",
      status: "skip",
      detail: "no --git-port given; the worker learns this port from the board per assignment, so it cannot be inferred here",
      remedy: "Pass --git-port <KANBAN_GIT_HTTP_PORT> to check it.",
    };
  }
  // Same hostname, substituted port — exactly how the worker composes a clone URL, so this
  // probe fails for the same reasons a real clone would (including the path-prefix trap:
  // any prefix in --board is discarded here too).
  let base: URL;
  try {
    base = new URL(boardUrl);
  } catch {
    return bad("git transport reachable", `--board is not a URL: ${boardUrl}`);
  }
  const url = `${base.protocol}//${base.hostname}:${gitPort}/git/`;
  const probe = await probeHttp(url);
  if (!probe.reachable) {
    return bad(
      "git transport reachable",
      `${url} could not be reached: ${probe.error}`,
      "Set KANBAN_GIT_HTTP_PORT on the board and make sure KANBAN_GIT_HTTP_HOST names an interface " +
        "this machine can route to. Never put a path-based reverse proxy in front of it (docs §8).",
    );
  }
  // 401/404 are GOOD news: the listener is up and refusing an unauthenticated, project-less
  // request, which is exactly what it should do. Only a transport error is a failure.
  return ok("git transport reachable", `${url} answered ${probe.status} (a listener is there and authenticating)`);
}

/** Check 5 — git on PATH. The transport is useless without it. */
async function checkGit(): Promise<DoctorCheck> {
  const probe = await probeCommand("git", ["--version"]);
  if (!probe.found) return bad("git on PATH", "git is not on this machine's PATH", "Install git and re-open the shell.");
  return ok("git on PATH", probe.output.split("\n")[0] ?? "git present");
}

/**
 * Check 6 — the provider CLI, installed AND logged in.
 *
 * The board cannot diagnose this at all: a worker authenticates the agent with its OWN
 * local login and the board sends no credentials (decision 012), so "installed but not
 * logged in" looks to the board exactly like a healthy worker that keeps failing its
 * sessions. `installed` is proven by running the binary; `logged in` is inferred from the
 * auth files the board's own rotation ring uses, and reported as `unknown` rather than
 * `pass` when they are absent but an API key may be in the environment instead.
 */
export async function checkProvider(provider: string, home: string = homedir()): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const version = await probeCommand(provider, ["--version"]);
  if (!version.found) {
    checks.push(
      bad(
        `${provider} CLI installed`,
        `'${provider}' is not on this machine's PATH`,
        `Install the ${provider} CLI here. The board never ships it — a worker runs the provider locally.`,
      ),
    );
    return checks;
  }
  checks.push(ok(`${provider} CLI installed`, version.output.split("\n")[0] ?? "present"));

  const auth = PROVIDER_AUTH_FILES[provider];
  if (!auth) {
    checks.push({
      name: `${provider} logged in`,
      status: "unknown",
      detail: `no known auth-file location for '${provider}', so this cannot be checked offline`,
      remedy: `Run a one-shot ${provider} command here and confirm it does not prompt for a login.`,
    });
    return checks;
  }
  const dir = join(home, auth.dir);
  const present = auth.files.filter((f) => existsSync(join(dir, f)));
  if (present.length > 0) {
    checks.push(ok(`${provider} logged in`, `${dir} holds ${present.join(", ")}`));
    return checks;
  }
  checks.push({
    name: `${provider} logged in`,
    // NOT a fail: an API key in the environment is a legitimate second way to be
    // authenticated, and this check cannot see one. Saying "fail" would send an operator
    // chasing a login that is already fine.
    status: "unknown",
    detail: `none of ${auth.files.join(", ")} found in ${dir} — either not logged in, or authenticated by an env API key this check cannot see`,
    remedy: `If sessions fail with an auth error, run: ${auth.loginCommand}`,
  });
  return checks;
}

export interface WorkerDoctorOptions {
  boardUrl: string;
  stateFile: string;
  providers: string[];
  gitPort?: number;
  home?: string;
  timeoutMs?: number;
}

/** The worker-machine half. Runs every hop this side can actually prove. */
export async function runWorkerDoctor(opts: WorkerDoctorOptions): Promise<DoctorReport> {
  const boardUrl = opts.boardUrl.replace(/\/+$/, "");
  const identity = readSavedIdentity(opts.stateFile, boardUrl);
  const checks: DoctorCheck[] = [];
  checks.push(await checkReachable(boardUrl));
  checks.push(await checkHeartbeat(boardUrl, identity));
  checks.push(await checkWebSocket(boardUrl, identity, opts.timeoutMs));
  checks.push(await checkGitTransport(boardUrl, opts.gitPort));
  checks.push(await checkGit());
  for (const provider of opts.providers) {
    checks.push(...(await checkProvider(provider, opts.home)));
  }
  return { side: "worker", boardUrl, checks, ok: checks.every((c) => c.status !== "fail") };
}

/** One row of the board's own fleet view, as `GET /api/workers` now answers it. */
interface BoardWorkerRow {
  id: string;
  name: string;
  effectiveStatus: string;
  connected: boolean;
  load: number;
  maxConcurrency: number;
  freeSlots: number;
  eligible: boolean;
  ineligibleReason: string | null;
  workerVersion?: string;
}

/**
 * The board-machine half: what the board SEES. Runs only where the owner routes are
 * mounted, which is why it is a separate command (docs §1).
 */
export async function runBoardDoctor(opts: {
  boardUrl: string;
  projectId?: string;
  provider?: string;
}): Promise<DoctorReport> {
  const boardUrl = opts.boardUrl.replace(/\/+$/, "");
  const checks: DoctorCheck[] = [];
  const params = new URLSearchParams();
  if (opts.projectId) params.set("projectId", opts.projectId);
  if (opts.provider) params.set("provider", opts.provider);
  const query = params.toString();

  interface BoardFleetView {
    workers?: BoardWorkerRow[];
    fleet?: { freeSlots: number; eligible: number; registered: number };
  }
  let body: BoardFleetView | null = null;
  try {
    const res = await fetch(`${boardUrl}/api/workers${query ? `?${query}` : ""}`);
    if (!res.ok) {
      checks.push(
        bad(
          "owner surface reachable",
          `GET /api/workers answered ${res.status}`,
          res.status === 404
            ? "This looks like the FLEET port. doctor-board must run on the board machine against its API port (default 3001)."
            : "Is the board running?",
        ),
      );
      return { side: "board", boardUrl, checks, ok: false };
    }
    body = (await res.json()) as BoardFleetView;
    checks.push(ok("owner surface reachable", `GET /api/workers answered 200 at ${boardUrl}`));
  } catch (err) {
    checks.push(
      bad(
        "owner surface reachable",
        `could not reach ${boardUrl}/api/workers: ${err instanceof Error ? err.message : String(err)}`,
        "Run this ON THE BOARD MACHINE — the owner routes are mounted only on the loopback app.",
      ),
    );
    return { side: "board", boardUrl, checks, ok: false };
  }

  const workers = body?.workers ?? [];
  if (workers.length === 0) {
    checks.push({
      name: "workers registered",
      status: "fail",
      detail: "no worker is registered with this board",
      remedy: "agentic-kanban worker pair, then run `worker start --token <token>` on the other machine.",
    });
    return { side: "board", boardUrl, checks, ok: false };
  }
  checks.push(ok("workers registered", `${workers.length} worker(s) registered`));

  for (const w of workers) {
    if (w.effectiveStatus !== "online") {
      checks.push(
        bad(
          `worker ${w.name}`,
          `effectiveStatus is ${w.effectiveStatus} — the last heartbeat is older than 90 s, or it is draining`,
          "Run `worker doctor` on that machine; if the daemon is up, the fleet port is what to check.",
        ),
      );
      continue;
    }
    if (!w.connected) {
      // The single most confusing fleet state, and one of the five eligibility failures
      // that all printed the same "no eligible worker" before #755.
      checks.push(
        bad(
          `worker ${w.name}`,
          "heartbeat is fresh but the board holds no WebSocket for it — it will never be picked",
          "Something between the machines is dropping the socket while letting HTTP through: run " +
            "`worker doctor` there and read the websocket-upgrade check.",
        ),
      );
      continue;
    }
    if (!w.eligible) {
      checks.push({
        name: `worker ${w.name}`,
        status: "fail",
        detail: w.ineligibleReason ?? "not a candidate for the resolved provider/labels",
        remedy: "worker explain <issue> names the check that decided and the preference to change.",
      });
      continue;
    }
    checks.push(ok(`worker ${w.name}`, `online, connected, eligible — ${w.freeSlots}/${w.maxConcurrency} slots free`));
  }

  if (body?.fleet) {
    const { freeSlots, eligible, registered } = body.fleet;
    checks.push(
      freeSlots > 0
        ? ok("free capacity", `${freeSlots} free slot(s) across ${eligible} eligible of ${registered} worker(s)`)
        : bad(
            "free capacity",
            `0 free slots (${eligible} eligible of ${registered} registered) — every slot is in use`,
            "Nothing is broken; a strict-dispatch project will hold until a slot frees up.",
          ),
    );
  }

  return { side: "board", boardUrl, checks, ok: checks.every((c) => c.status !== "fail") };
}

const ICONS: Record<CheckStatus, string> = { pass: "PASS", fail: "FAIL", skip: "SKIP", unknown: "????" };

/** Human-readable report. Deliberately plain text — this gets pasted into an issue. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(
    report.side === "worker"
      ? `Worker-side self-test against ${report.boardUrl}`
      : `Board-side fleet check at ${report.boardUrl}`,
  );
  lines.push("");
  for (const c of report.checks) {
    lines.push(`  [${ICONS[c.status]}] ${c.name}: ${c.detail}`);
    if (c.remedy && c.status !== "pass") lines.push(`         -> ${c.remedy}`);
  }
  lines.push("");
  const failed = report.checks.filter((c) => c.status === "fail").length;
  const unknown = report.checks.filter((c) => c.status === "unknown").length;
  lines.push(
    failed === 0
      ? `All ${report.checks.length} checks passed or were skipped${unknown > 0 ? ` (${unknown} indeterminate — see above)` : ""}.`
      : `${failed} check(s) failed.`,
  );
  if (report.side === "worker") {
    lines.push(
      "This half cannot see how the board views this machine — the owner routes are loopback-only " +
        "(docs/worker-fleet.md §1). Run `agentic-kanban worker doctor-board` on the board for that half.",
    );
  }
  return lines.join("\n");
}
