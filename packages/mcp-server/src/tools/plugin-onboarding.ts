import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApi } from "../board-call.js";
import { mcpContent } from "../db-utils.js";

/**
 * First-class plugin ONBOARDING tools (#390), so the butler stops hand-rolling `curl` against a
 * drifting port for the one flow it is most often asked to run.
 *
 * Every step here already had an HTTP endpoint; what was missing was a tool, which is why the
 * butler's own guide had to spell out URLs — and why a port change silently broke the flow.
 *
 * ── The ordering constraint is the whole point (#318) ──
 *
 * ENABLING a plugin SCAFFOLDS it, so the output location must be chosen BEFORE enabling, never
 * after: enabling first writes the scaffold into the leading repo, and a later switch to sidecar
 * leaves it stranded in the wrong place. `enable_plugin` therefore takes an optional `location`
 * and applies it first, and the descriptions say so where the model will actually read them.
 */

function failure(what: string, res: { status: number; data: unknown }): string {
  const detail = (res.data as { error?: string } | null)?.error;
  return `${what} failed (${res.status})${detail ? `: ${detail}` : ""}`;
}

export function registerEnablePlugin(server: McpServer) {
  server.tool(
    "enable_plugin",
    "Enable an installed plugin for ONE project. Enabling SCAFFOLDS the plugin's profile into the "
    + "output repo, so if the plugin should write to a sidecar repo rather than the product repo, pass "
    + "`location: \"sidecar\"` HERE — setting it afterwards leaves the scaffold stranded in the wrong "
    + "repo (#318). Use list_plugins to get the plugin row id.",
    {
      pluginId: z.string().describe("Plugin ROW id (from list_plugins), not the manifest slug"),
      projectId: z.string().describe("The project to enable it for"),
      location: z.enum(["leading", "sidecar"]).optional()
        .describe("Where the plugin writes its output. Applied BEFORE scaffolding. Default: leading (the product repo)."),
    },
    async ({ pluginId, projectId, location }) => {
      const res = await boardApi(`/api/plugins/${pluginId}/enable`, {
        method: "POST",
        body: JSON.stringify({ projectId, ...(location ? { location } : {}) }),
      });
      if (!res.ok) return mcpContent(failure("enable_plugin", res));
      return mcpContent(res.data ?? "Enabled.");
    },
  );
}

export function registerSetPluginOutputLocation(server: McpServer) {
  server.tool(
    "set_plugin_output_location",
    "Set where a plugin writes its output for one project: \"leading\" (the product repo) or \"sidecar\" "
    + "(a separate <slug>-requirements repo). Prefer passing `location` to enable_plugin instead — "
    + "enabling scaffolds, so changing the location afterwards does not move what was already written.",
    {
      pluginId: z.string().describe("Plugin ROW id"),
      projectId: z.string().describe("The project"),
      location: z.enum(["leading", "sidecar"]).describe("leading = product repo, sidecar = separate output repo"),
    },
    async ({ pluginId, projectId, location }) => {
      const res = await boardApi(`/api/plugins/${pluginId}/output-location`, {
        method: "POST",
        body: JSON.stringify({ projectId, location }),
      });
      if (!res.ok) return mcpContent(failure("set_plugin_output_location", res));
      return mcpContent(res.data ?? "Set.");
    },
  );
}

export function registerGetPluginScaffold(server: McpServer) {
  server.tool(
    "get_plugin_scaffold",
    "Read the plugin's scaffolded profile as an INTERVIEW: the unresolved TODO markers, each with its "
    + "index and the question it asks. Ask the USER these questions — the answers are project facts, not "
    + "things to invent — then submit them with fill_plugin_scaffold.",
    {
      pluginId: z.string().describe("Plugin ROW id"),
      projectId: z.string().describe("The project"),
    },
    async ({ pluginId, projectId }) => {
      const res = await boardApi(`/api/plugins/${pluginId}/scaffold?projectId=${encodeURIComponent(projectId)}`);
      if (!res.ok) return mcpContent(failure("get_plugin_scaffold", res));
      return mcpContent(res.data);
    },
  );
}

export function registerFillPluginScaffold(server: McpServer) {
  server.tool(
    "fill_plugin_scaffold",
    "Answer the plugin profile's TODO markers by INDEX (from get_plugin_scaffold). Only call this with "
    + "answers the user actually gave: the profile drives what the plugin's loops generate, so an invented "
    + "answer silently becomes a wrong requirement register.",
    {
      pluginId: z.string().describe("Plugin ROW id"),
      projectId: z.string().describe("The project"),
      values: z.array(z.object({
        index: z.number().describe("The marker index from get_plugin_scaffold"),
        value: z.string().describe("The user's answer, verbatim where possible"),
      })).describe("One entry per marker you are answering; unanswered markers stay open"),
    },
    async ({ pluginId, projectId, values }) => {
      const res = await boardApi(`/api/plugins/${pluginId}/scaffold`, {
        method: "POST",
        body: JSON.stringify({ projectId, values }),
      });
      if (!res.ok) return mcpContent(failure("fill_plugin_scaffold", res));
      return mcpContent(res.data ?? "Saved.");
    },
  );
}
