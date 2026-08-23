import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApi, boardErrorText, mcpJson, mcpText, mcpUnreachable } from "../board-call.js";
import { prodDeps, type ToolDeps } from "./deps.js";
import { resolveActiveProjectId } from "../db-utils.js";

/**
 * The worker fleet as MCP tools (#774, remaining #755 item 3).
 *
 * Until now the fleet was reachable only from a terminal on the board machine: an agent
 * asked to find out why a project was not dispatching remotely, or to pair a new worker,
 * had to hand-roll curl against a port it had to guess — which is exactly the "don't
 * hand-roll `curl | python`" the board's own conventions forbid. Every tool here is a thin
 * pass-through to a REST endpoint that already exists, so there is no second implementation
 * of eligibility, capacity or the placement chain.
 *
 * NOTE ON NAMING: `get_fleet_friction` is an UNRELATED tool (agent-session tool-call
 * friction, nothing to do with worker machines). The `worker_` prefix here is what keeps
 * the two apart for an agent picking a tool by name.
 *
 * All five ride the board's loopback trust model, like the owner half of
 * `/api/workers` — minting a pairing token and revoking a worker are administrative
 * actions with no credential of their own.
 */
export function registerListWorkers(server: McpServer, _deps: ToolDeps = prodDeps) {
  server.tool(
    "list_workers",
    "List the board's registered fleet workers with LIVE state: effective status, whether the board holds a WebSocket for each one, current load, real free slots, per-worker eligibility for a provider (and why an ineligible worker is not a candidate), labels, providers, protocol version and build. Use before dispatching remote work, or when a project opted into worker dispatch and everything still runs on the board host. NOT related to get_fleet_friction (that is agent-session tool friction).",
    {
      projectId: z.string().optional().describe("Resolve required capability labels from this project's worker_labels_<projectId> preference. Omit for an unrestricted view."),
      provider: z.string().optional().describe("Provider to judge eligibility for (claude | codex | copilot | pi). Default: claude."),
    },
    async ({ projectId, provider }) => {
      const params = new URLSearchParams();
      if (projectId) params.set("projectId", projectId);
      if (provider) params.set("provider", provider);
      const query = params.toString();
      try {
        const { ok, statusText, data } = await boardApi(`/api/workers${query ? `?${query}` : ""}`);
        if (!ok) return mcpText(`Failed to list workers: ${boardErrorText(data, statusText)}`);
        return mcpJson(data);
      } catch (err) {
        return mcpUnreachable(err);
      }
    },
  );
}

export function registerExplainWorkerPlacement(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "explain_worker_placement",
    "Why was issue #N not dispatched to a fleet worker? Walks the SAME ordered chain resolveWorkerPlacement applies — dispatch opt-in, profile allowlist, eligible worker, branch for git transport, project repoPath, repository shape — against live state, names the check that decided, shows the values it read and the preference keys to change, and cross-checks its own answer against the real resolver (agreesWithResolver: false means the explanation has drifted and the resolver is the truth). Omit issueNumber for a project-level 'would anything dispatch right now?'.",
    {
      issueNumber: z.number().optional().describe("Issue number to explain. Omit for a project-level answer."),
      projectId: z.string().optional().describe("Project ID (defaults to the active project)"),
      provider: z.string().optional().describe("Provider to resolve for (defaults to what this project's next launch would use)"),
    },
    async ({ issueNumber, projectId, provider }) => {
      const rpid = await resolveActiveProjectId(db, schema, projectId);
      if (!rpid.ok) return rpid.error;
      const params = new URLSearchParams({ projectId: rpid.projectId });
      if (issueNumber !== undefined) params.set("issue", String(issueNumber));
      if (provider) params.set("provider", provider);
      try {
        const { ok, statusText, data } = await boardApi(`/api/workers/explain?${params}`);
        if (!ok) return mcpText(`Failed to explain placement: ${boardErrorText(data, statusText)}`);
        return mcpJson(data);
      } catch (err) {
        return mcpUnreachable(err);
      }
    },
  );
}

export function registerMintWorkerPairingToken(server: McpServer, _deps: ToolDeps = prodDeps) {
  server.tool(
    "mint_worker_pairing_token",
    "Mint a single-use, expiring pairing token so another machine can register as a fleet worker. Returns the token and its expiry, plus the command to run on the worker machine. The token is the ONLY credential in the flow — the board never sends agent credentials to a worker (decision 012), so the worker authenticates its own agent with its own local login.",
    {},
    async () => {
      try {
        const { ok, statusText, data } = await boardApi("/api/workers/pairing-token", { method: "POST" });
        if (!ok) return mcpText(`Failed to mint a pairing token: ${boardErrorText(data, statusText)}`);
        const token = (data as { pairingToken?: string } | null)?.pairingToken;
        return mcpJson({
          ...(data as Record<string, unknown>),
          // The token alone is not actionable; the command is. Both, so an agent that
          // relays this to a human does not have to reconstruct the invocation.
          command: `agentic-kanban worker start --board <board-url> --token ${token ?? "<pairing-token>"}`,
          verifyOnWorker: "agentic-kanban worker doctor --board <board-url>",
        });
      } catch (err) {
        return mcpUnreachable(err);
      }
    },
  );
}

export function registerRevokeWorker(server: McpServer, _deps: ToolDeps = prodDeps) {
  server.tool(
    "revoke_worker",
    "Revoke a fleet worker: its bearer token stops working immediately, its live socket is closed, its per-assignment git tokens are deleted and its event timeline is dropped. Takes the worker ID from list_workers. Does NOT touch sessions that already ran on it — sessions keep their worker_id so past placements stay attributable.",
    {
      workerId: z.string().describe("Worker ID, from list_workers"),
    },
    async ({ workerId }) => {
      try {
        const { ok, statusText, data } = await boardApi(`/api/workers/${workerId}`, { method: "DELETE" });
        if (!ok) return mcpText(`Failed to revoke worker ${workerId}: ${boardErrorText(data, statusText)}`);
        return mcpJson({ workerId, ...(data as Record<string, unknown>) });
      } catch (err) {
        return mcpUnreachable(err);
      }
    },
  );
}

export function registerListIncomingRefs(server: McpServer, _deps: ToolDeps = prodDeps) {
  server.tool(
    "list_incoming_refs",
    "List the incoming-ref staging namespace: branches a fleet worker pushed to refs/kanban/incoming/* that the board has not fast-forwarded onto a real branch, each with why it is held (no worker assignment, diverged, already landed, invalid ref name) and whether it is stale. This is where a remote worker's work sits when a landing was refused — the board is fast-forward-only and never forces, so a held ref needs a deliberate land or discard.",
    {
      projectId: z.string().optional().describe("Restrict to one project. Omit for every project with a repo path."),
    },
    async ({ projectId }) => {
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      try {
        const { ok, statusText, data } = await boardApi(`/api/workers/incoming${query}`);
        if (!ok) return mcpText(`Failed to list incoming refs: ${boardErrorText(data, statusText)}`);
        return mcpJson(data);
      } catch (err) {
        return mcpUnreachable(err);
      }
    },
  );
}
