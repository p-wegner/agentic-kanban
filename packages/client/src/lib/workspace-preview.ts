import type { DevServerPlan, DevServerPlanSource, WorkspaceDevServerPlanResponse } from "@agentic-kanban/shared";

const DEFAULT_CLIENT_PORT = 5173;
const DEFAULT_SERVER_PORT = 3001;

export type WorkspacePreviewResult =
  | { ok: true; port: number; url: string }
  | { ok: false; reason: string };

function getIssueNumber(branchName: string): number | null {
  const match = branchName.match(/^feature\/(?:ak-)?(\d+)-/);
  return match ? parseInt(match[1], 10) : null;
}

function branchHash(branchName: string): number {
  let hash = 0;
  for (let i = 0; i < branchName.length; i++) {
    hash = (hash * 31 + branchName.charCodeAt(i)) & 0xffff;
  }
  return (hash % 900) + 101;
}

export function getWorkspacePreviewUrl(workspace: { branch?: string | null; isDirect?: boolean }): WorkspacePreviewResult {
  const ports = getWorkspaceDevPorts(workspace);
  if (!ports.ok) return { ok: false, reason: ports.reason };
  return { ok: true, port: ports.clientPort, url: `http://127.0.0.1:${ports.clientPort}` };
}

export type WorkspaceDevPortsResult =
  | { ok: true; serverPort: number; clientPort: number; previewUrl: string }
  | { ok: false; reason: string };

export function getWorkspaceDevPorts(workspace: { branch?: string | null; isDirect?: boolean }): WorkspaceDevPortsResult {
  if (workspace.isDirect) {
    return {
      ok: true,
      serverPort: DEFAULT_SERVER_PORT,
      clientPort: DEFAULT_CLIENT_PORT,
      previewUrl: `http://127.0.0.1:${DEFAULT_CLIENT_PORT}`,
    };
  }

  const branch = workspace.branch?.trim();
  if (!branch) {
    return { ok: false, reason: "Dev ports unavailable: workspace branch is missing." };
  }

  const issueNumber = getIssueNumber(branch);
  const offset = issueNumber ?? branchHash(branch);
  const clientPort = DEFAULT_CLIENT_PORT + offset;
  const serverPort = DEFAULT_SERVER_PORT + offset;
  if (clientPort > 60000 || serverPort > 60000) {
    return { ok: false, reason: `Dev ports ${serverPort}/${clientPort} are outside the supported range.` };
  }

  return {
    ok: true,
    serverPort,
    clientPort,
    previewUrl: `http://127.0.0.1:${clientPort}`,
  };
}

// ──────────────── Honest dev-server plan display (ticket #100) ────────────────
// The port math above is THIS app's private worktree convention (3001+N/5173+N). It is
// correct only for agentic-kanban's own worktrees. For every other project the board
// drives (a docker-compose stack, a multi-repo app), the real dev-server command/port
// come from the server-resolved `DevServerPlan` — the diagnostics tab renders that
// instead of assuming this app's ports.

const SOURCE_LABELS: Record<DevServerPlanSource["port"], string> = {
  pref: "project override",
  profile: "stack profile",
  "worktree-port": "app worktree convention",
  none: "unknown",
};

/** Human label for where a resolved plan field came from. */
export function devServerSourceLabel(source: DevServerPlanSource["port"]): string {
  return SOURCE_LABELS[source] ?? "unknown";
}

/** The origin (scheme://host:port) of a health URL, dropping its path — or null if unparseable. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export interface DevServerPlanDisplay {
  /** Status badge for the "Dev server" row: "web", "service", "none" or "unknown". */
  status: string;
  /** The resolved start command, or an honest "no command" note. */
  command: string;
  /** One line describing the resolved endpoint/port and its provenance. */
  endpoint: string;
  /** A base URL worth opening, when one is actually known; else null. */
  previewUrl: string | null;
}

/**
 * Turn a resolved dev-server plan response into honest display strings for the
 * diagnostics tab. Never fabricates a port: when the plan can't know one, it says so.
 */
export function describeDevServerPlan(response: WorkspaceDevServerPlanResponse | null): DevServerPlanDisplay {
  const plan: DevServerPlan | null = response?.plan ?? null;
  if (!plan) {
    return {
      status: "none",
      command: "No dev-server command configured or detected for this project.",
      endpoint: "No dev server known — nothing to preview.",
      previewUrl: null,
    };
  }

  const status = plan.isWeb ? "web" : "service";
  if (plan.port == null) {
    return {
      status,
      command: plan.command,
      endpoint: plan.isWeb
        ? "Port unknown for this project (no dev-server URL, override or profile port configured)."
        : "Headless service — no HTTP port.",
      previewUrl: null,
    };
  }

  const origin = plan.healthUrl ? originOf(plan.healthUrl) : `http://127.0.0.1:${plan.port}`;
  const where = devServerSourceLabel(plan.source.port);
  const target = plan.healthUrl ?? `http://127.0.0.1:${plan.port}`;
  return {
    status,
    command: plan.command,
    endpoint: `${target} — port ${plan.port} (${where})`,
    previewUrl: plan.isWeb ? origin : null,
  };
}
