import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getServerPort } from "../server-url.js";

/**
 * First-class plugin-gate tools (#308) — so the butler (and any MCP consumer) can list,
 * inspect and resolve plugin-loop approval gates without hand-rolled curl. The HARD rule
 * rides in the tool descriptions: resolving a gate is a HUMAN decision — the model may
 * only call resolve_plugin_gate after the user explicitly stated that decision.
 */

async function api(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`http://127.0.0.1:${getServerPort()}/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, data };
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

interface SurfaceLoop {
  pluginId: string;
  pluginSlug: string;
  pluginName: string;
  name: string;
  label: string;
  openTickets: number;
  gate: { id: string; question: string; artifacts?: string[]; actions: Array<{ id: string; label: string; input?: string }> } | null;
  checks: Array<{ name: string; verdict: string; detail?: string }> | null;
  gateRecommendation: { actionId: string; reason: string } | null;
  /**
   * #299's finished-but-unlanded stall, plus (#363) a workspace parked `ready_for_merge` whose
   * issue never left In Progress. `mergeSafe: false` marks the second kind: do NOT merge it —
   * the measured instance's branch had zero commits, and landing it would close the unit
   * without its artifacts.
   */
  awaitingMerge: {
    workspaceId: string;
    issueNumber: number | null;
    issueTitle: string;
    reason?: string;
    mergeSafe?: boolean;
    detail?: string;
  } | null;
  note: string | null;
}

async function surfaceLoops(projectId: string): Promise<SurfaceLoop[]> {
  const res = await api(`/projects/${projectId}/plugin-surface`);
  if (!res.ok) throw new Error(`plugin-surface failed (${res.status})`);
  return ((res.data as { loops?: SurfaceLoop[] }).loops ?? []);
}

export function registerListPluginGates(server: McpServer) {
  server.tool(
    "list_plugin_gates",
    "List plugin-loop approval gates waiting on a HUMAN decision for ONE project (question, verification checks, artifacts, the butler's recommendation if any). Also reports loops whose finished ticket is still waiting for its merge to land. For a question spanning MULTIPLE projects use list_inbox instead — calling this once per project and stitching the results mis-attributes items to the wrong project.",
    { projectId: z.string().describe("The project ID") },
    async ({ projectId }) => {
      try {
        const loops = await surfaceLoops(projectId);
        const gates = loops
          .filter((l) => (l.gate && l.openTickets === 0) || l.awaitingMerge)
          .map((l) => ({
            pluginId: l.pluginId,
            pluginName: l.pluginName,
            loopName: l.name,
            loopLabel: l.label,
            gate: l.gate && l.openTickets === 0 ? l.gate : null,
            checks: l.checks,
            recommendation: l.gateRecommendation,
            awaitingMerge: l.awaitingMerge,
            note: l.note,
          }));
        return text(gates.length ? gates : "No plugin gates are waiting.");
      } catch (err) {
        return text(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

export function registerGetPluginGate(server: McpServer) {
  server.tool(
    "get_plugin_gate",
    "Get the full detail of one pending plugin gate: question, actions, verification checks, artifact paths (read those files for the content), and the butler's recommendation.",
    {
      projectId: z.string().describe("The project ID"),
      pluginId: z.string().describe("Plugin row id (from list_plugin_gates)"),
      loopName: z.string().describe("Loop name (from list_plugin_gates)"),
    },
    async ({ projectId, pluginId, loopName }) => {
      try {
        const loop = (await surfaceLoops(projectId)).find((l) => l.pluginId === pluginId && l.name === loopName);
        if (!loop) return text(`Loop "${loopName}" of plugin ${pluginId} not found or not enabled for this project.`);
        return text({
          gate: loop.gate, checks: loop.checks, recommendation: loop.gateRecommendation,
          awaitingMerge: loop.awaitingMerge, openTickets: loop.openTickets, note: loop.note,
        });
      } catch (err) {
        return text(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

/**
 * The CROSS-project inbox (#441). Every other tool here is single-project, so a
 * question like "what needs my attention across the whole board?" forced a manual
 * fan-out over every project plus hand-stitching of the results — and hand-stitching
 * is where it went wrong: a real butler answer named the right issue numbers and
 * titles under the WRONG project names (eventhub #28 reported as bugtrack #28,
 * pantry #33 as habithub #33).
 *
 * `GET /api/inbox` already does this correctly server-side, with each item carrying
 * its own projectId/projectName, so the fix is exposure, not computation.
 */
export function registerListInbox(server: McpServer) {
  server.tool(
    "list_inbox",
    "Everything blocked on a HUMAN across ALL projects at once: plugin-loop gates, finished-but-unlanded loop merges, unanswered agent questions and pending tool approvals — each carrying its own project. USE THIS for any cross-project \"what needs my attention / what is waiting on me\" question instead of calling the per-project tools once per project; fanning out by hand mis-attributes items to the wrong project.",
    {},
    async () => {
      const res = await api("/inbox");
      if (!res.ok) return text(`Inbox failed (${res.status}): ${JSON.stringify(res.data)}`);
      const items = (res.data as { items?: unknown[] }).items ?? [];
      return text(items.length ? items : "Nothing is waiting on you on any project.");
    },
  );
}

export function registerResolvePluginGate(server: McpServer) {
  server.tool(
    "resolve_plugin_gate",
    "Apply a HUMAN's decision to a pending plugin gate (approve / request revisions). HARD RULE: only call this after the user has EXPLICITLY stated their decision in the current conversation — never resolve a gate on your own judgment or a recommendation alone. Revision-style actions require the user's feedback text.",
    {
      projectId: z.string().describe("The project ID"),
      pluginId: z.string().describe("Plugin row id"),
      loopName: z.string().describe("Loop name"),
      gateId: z.string().describe("The gate id being decided (staleness-checked server-side)"),
      actionId: z.string().describe("One of the gate's action ids, e.g. \"approve\" or \"revise\""),
      input: z.string().optional().describe("The user's feedback text — required by revision-style actions"),
    },
    async ({ projectId, pluginId, loopName, gateId, actionId, input }) => {
      const res = await api(`/plugins/${pluginId}/loops/${loopName}/gate/resolve`, {
        method: "POST",
        body: JSON.stringify({ projectId, gateId, actionId, input }),
      });
      if (!res.ok) return text(`Gate resolve failed (${res.status}): ${JSON.stringify(res.data)}`);
      return text(res.data);
    },
  );
}

export function registerAdvancePluginLoop(server: McpServer) {
  server.tool(
    "advance_plugin_loop",
    "Re-run a plugin loop's planner now (plan → dedupe → create tickets). Safe and idempotent; use after a merge landed or to refresh a loop's gate/progress state.",
    {
      projectId: z.string().describe("The project ID"),
      pluginId: z.string().describe("Plugin row id"),
      loopName: z.string().describe("Loop name"),
    },
    async ({ projectId, pluginId, loopName }) => {
      const res = await api(`/plugins/${pluginId}/loops/${loopName}/advance`, {
        method: "POST",
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) return text(`Advance failed (${res.status}): ${JSON.stringify(res.data)}`);
      return text(res.data);
    },
  );
}
