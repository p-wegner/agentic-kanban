import type { Command } from "commander";
import { resolveCliPort } from "./workspace-api-url.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { resolveProjectIdArg } from "../shared.js";

/**
 * `pnpm cli -- plugin-sync ...` — the CLI counterpart of the `/api/plugins/:id/sync/*` routes
 * (#1081). Talks to the running dev server over HTTP, same pattern as `butler.ts`: the plugin
 * service's view/script/loop runtime already lives IN that process, so a CLI-side in-process
 * call would need its own copy of that state.
 *
 * Every subcommand identifies the plugin by its manifest SLUG (the id shown in `plugin list`),
 * not the internal row id — the slug is what a user reads and types.
 */

const SERVER_PORT = resolveCliPort();

function apiUrl(path: string): string {
  return `http://127.0.0.1:${SERVER_PORT}${path.startsWith("/") ? path : `/${path}`}`;
}

async function requirePluginRowId(pluginSlug: string): Promise<string> {
  const res = await fetch(apiUrl("/api/plugins")).catch(() => null);
  if (!res || !res.ok) {
    throw new Error(`Failed to list plugins — is the dev server running on port ${SERVER_PORT}?`);
  }
  const rows = (await res.json()) as Array<{ id: string; pluginId: string }>;
  const row = rows.find((r) => r.pluginId === pluginSlug);
  if (!row) throw new Error(`No installed plugin named "${pluginSlug}". Run \`pnpm cli -- plugin list\` to see them.`);
  return row.id;
}

/** Issue a JSON request against `/api/plugins/:id/sync/...` and print the (already-parsed) body. */
async function callSync(
  pluginRowId: string,
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<{ status: number; data: Record<string, unknown> }> {
  const url = apiUrl(`/api/plugins/${encodeURIComponent(pluginRowId)}/sync${path}`);
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json()) as Record<string, unknown>;
  return { status: res.status, data };
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

/** Shared prelude: resolve project + plugin row id, run the call, print, exit non-zero on error/refusal. */
async function run(
  pluginSlug: string,
  projectArg: string | undefined,
  fn: (projectId: string, pluginRowId: string) => Promise<{ status: number; data: Record<string, unknown> }>,
  opts: { failWhen?: (data: Record<string, unknown>) => boolean } = {},
): Promise<void> {
  try {
    const projectId = await resolveProjectIdArg(projectArg);
    const pluginRowId = await requirePluginRowId(pluginSlug);
    const { status, data } = await fn(projectId, pluginRowId);
    printJson(data);
    if (status >= 400 || opts.failWhen?.(data)) process.exit(1);
  } catch (err) {
    console.error("Error:", errorMessage(err));
    process.exit(1);
  }
}

export function registerPluginSyncCommand(program: Command) {
  const cmd = program
    .command("plugin-sync")
    .description("Configure, validate and trigger a plugin's external-issue-tracker sync (#1076/#1081). Requires the dev server to be running.\n\nSubcommands: config-get, config-set, validate, trigger, status")
    .addHelpText("after", `
Examples:
  $ agentic-kanban plugin-sync config-get jira-sync
  $ agentic-kanban plugin-sync config-set jira-sync siteUrl https://example.atlassian.net
  $ agentic-kanban plugin-sync validate jira-sync
  $ agentic-kanban plugin-sync trigger jira-sync pull --dry-run
  $ agentic-kanban plugin-sync status jira-sync
`);

  cmd
    .command("config-get <plugin>")
    .description("Show declared sync config fields, their current values, and which declared secrets the board can resolve.")
    .option("--project <nameOrId>", "Project to read (defaults to the active project)")
    .action(async (pluginSlug: string, opts: { project?: string }) => {
      await run(pluginSlug, opts.project, (projectId, pluginRowId) =>
        callSync(pluginRowId, `/config?projectId=${encodeURIComponent(projectId)}`));
    });

  cmd
    .command("config-set <plugin> <key> <value>")
    .description("Set one declared sync config field's value.")
    .option("--project <nameOrId>", "Project to configure (defaults to the active project)")
    .action(async (pluginSlug: string, key: string, value: string, opts: { project?: string }) => {
      await run(pluginSlug, opts.project, (projectId, pluginRowId) =>
        callSync(pluginRowId, "/config", { method: "POST", body: { projectId, values: { [key]: value } } }));
    });

  cmd
    .command("validate <plugin>")
    .description("Check whether sync is fully configured — fails CLOSED with a readable reason instead of a server error.")
    .option("--project <nameOrId>", "Project to check (defaults to the active project)")
    .action(async (pluginSlug: string, opts: { project?: string }) => {
      await run(
        pluginSlug, opts.project,
        (projectId, pluginRowId) => callSync(pluginRowId, "/validate", { method: "POST", body: { projectId } }),
        { failWhen: (data) => data.ok !== true },
      );
    });

  cmd
    .command("trigger <plugin> <direction>")
    .description('Run the sync\'s "pull" or "push" command. Refuses (and records why) instead of running when validation fails.')
    .option("--project <nameOrId>", "Project to sync (defaults to the active project)")
    .option("--dry-run", "Ask the plugin's command to simulate the run (SYNC_DRY_RUN=1)", false)
    .action(async (pluginSlug: string, direction: string, opts: { project?: string; dryRun?: boolean }) => {
      if (direction !== "pull" && direction !== "push") {
        console.error('Error: direction must be "pull" or "push"');
        process.exit(1);
        return;
      }
      await run(
        pluginSlug, opts.project,
        (projectId, pluginRowId) => callSync(pluginRowId, "/trigger", {
          method: "POST",
          body: { projectId, direction, dryRun: Boolean(opts.dryRun) },
        }),
        { failWhen: (data) => data.ok !== true },
      );
    });

  cmd
    .command("status <plugin>")
    .description("Show the last recorded sync run — time, direction, outcome, counts/conflicts when the command reported them.")
    .option("--project <nameOrId>", "Project to read (defaults to the active project)")
    .action(async (pluginSlug: string, opts: { project?: string }) => {
      await run(pluginSlug, opts.project, (projectId, pluginRowId) =>
        callSync(pluginRowId, `/status?projectId=${encodeURIComponent(projectId)}`));
    });
}
