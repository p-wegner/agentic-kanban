import type { Command } from "commander";
import { db } from "../../db/index.js";
import { preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";

const SERVER_PORT = Number(process.env.SERVER_PORT) || Number(process.env.KANBAN_SERVER_PORT) || 3001;

async function resolveProjectId(explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  // Match the rest of the CLI (shared.ts uses "activeProjectId"); the previous
  // butler-ask used "active_project" which never matched anything written by `register`.
  const rows = await db.select().from(preferences).where(eq(preferences.key, "activeProjectId")).limit(1);
  return rows[0]?.value || null;
}

async function withProject<T>(
  options: { project?: string },
  fn: (projectId: string) => Promise<T>,
): Promise<void> {
  const projectId = await resolveProjectId(options.project);
  if (!projectId) {
    console.error("No active project. Pass --project <id> or set an active project first.");
    process.exit(1);
  }
  try {
    await fn(projectId);
  } finally {
    process.exit(0);
  }
}

/** Issue an HTTP request to a butler endpoint and print JSON or exit on error. */
async function callButler(
  projectId: string,
  path: string,
  init: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown; butler?: string } = {},
): Promise<unknown> {
  const butlerQuery = init.butler && init.butler !== "default"
    ? `${path.includes("?") ? "&" : "?"}butler=${encodeURIComponent(init.butler)}`
    : "";
  const url = `http://127.0.0.1:${SERVER_PORT}/api/projects/${projectId}/butler${path}${butlerQuery}`;
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const data = (await res.json()) as { error?: string } & Record<string, unknown>;
    if (!res.ok) {
      console.error(`Butler error (${res.status}): ${data.error ?? res.statusText}`);
      process.exit(1);
    }
    return data;
  } catch (err) {
    console.error(`Failed to reach the butler — is the dev server running on port ${SERVER_PORT}?`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function printJsonOrSummary(data: unknown, summary: string, json?: boolean) {
  if (json) console.log(JSON.stringify(data, null, 2));
  else console.log(summary);
}

interface AskResponse {
  sessionId: string | null;
  text: string;
  isError: boolean;
  error?: string;
}

export function registerButlerCommand(program: Command) {
  const butler = program
    .command("butler")
    .description("Interact with the project butler — a warm, persistent Claude assistant running in the project repo.");

  butler
    .command("ask <question...>")
    .description("Ask the butler a question and print its answer. Requires the dev server to be running.")
    .option("-p, --project <id>", "Project ID (defaults to active project)")
    .option("-b, --butler <id>", "Which butler to ask (definition id; defaults to the default butler)")
    .option("-t, --timeout <seconds>", "Max seconds to wait for the answer", "120")
    .option("--json", "Output the raw JSON response")
    .action(async (question: string[], options: { project?: string; butler?: string; timeout?: string; json?: boolean }) => {
      await withProject(options, async (projectId) => {
        const content = question.join(" ").trim();
        if (!content) {
          console.error("Question is empty.");
          process.exit(1);
        }
        const timeoutMs = (Number(options.timeout) || 120) * 1000;
        const data = (await callButler(projectId, "/ask", {
          method: "POST",
          body: { content, timeoutMs },
          butler: options.butler,
        })) as AskResponse;
        if (options.json) console.log(JSON.stringify(data, null, 2));
        else console.log(data.text);
      });
    });

  butler
    .command("ensure")
    .description("Start the butler's warm session if not already running.")
    .option("-p, --project <id>", "Project ID (defaults to active project)")
    .option("-b, --butler <id>", "Which butler (definition id; defaults to the default butler)")
    .option("--json", "Output the raw JSON response")
    .action(async (options: { project?: string; butler?: string; json?: boolean }) => {
      await withProject(options, async (projectId) => {
        const data = (await callButler(projectId, "/ensure", { method: "POST", body: {}, butler: options.butler })) as {
          active: boolean;
          sessionId: string | null;
        };
        printJsonOrSummary(data, `Butler active (sessionId: ${data.sessionId ?? "n/a"})`, options.json);
      });
    });

  butler
    .command("stop")
    .description("Stop the butler's warm session and forget the resume id (next ensure starts fresh).")
    .option("-p, --project <id>", "Project ID (defaults to active project)")
    .option("-b, --butler <id>", "Which butler (definition id; defaults to the default butler)")
    .option("--json", "Output the raw JSON response")
    .action(async (options: { project?: string; butler?: string; json?: boolean }) => {
      await withProject(options, async (projectId) => {
        const data = await callButler(projectId, "", { method: "DELETE", butler: options.butler });
        printJsonOrSummary(data, "Butler stopped.", options.json);
      });
    });

  butler
    .command("interrupt")
    .description("Interrupt the butler's in-flight turn (session stays warm).")
    .option("-p, --project <id>", "Project ID (defaults to active project)")
    .option("-b, --butler <id>", "Which butler (definition id; defaults to the default butler)")
    .option("--json", "Output the raw JSON response")
    .action(async (options: { project?: string; butler?: string; json?: boolean }) => {
      await withProject(options, async (projectId) => {
        const data = (await callButler(projectId, "/interrupt", { method: "POST", body: {}, butler: options.butler })) as { ok: boolean };
        printJsonOrSummary(data, `Interrupt: ${data.ok ? "sent" : "no-op (nothing in flight)"}`, options.json);
      });
    });

  butler
    .command("model <name>")
    .description('Switch the butler\'s model live (pass an empty string "" to revert to the profile default).')
    .option("-p, --project <id>", "Project ID (defaults to active project)")
    .option("-b, --butler <id>", "Which butler (definition id; defaults to the default butler)")
    .option("--json", "Output the raw JSON response")
    .action(async (name: string, options: { project?: string; butler?: string; json?: boolean }) => {
      await withProject(options, async (projectId) => {
        const data = (await callButler(projectId, "/model", { method: "POST", body: { model: name }, butler: options.butler })) as {
          ok: boolean; model: string; applied: boolean;
        };
        printJsonOrSummary(
          data,
          `Model set to "${data.model || "(default)"}" — ${data.applied ? "applied live" : "saved (no live session)"}.`,
          options.json,
        );
      });
    });

  butler
    .command("profile <name>")
    .description('Switch the butler\'s Claude profile. Restarts the session. Pass "" to inherit the global default.')
    .option("-p, --project <id>", "Project ID (defaults to active project)")
    .option("-b, --butler <id>", "Which butler (definition id; defaults to the default butler)")
    .option("--json", "Output the raw JSON response")
    .action(async (name: string, options: { project?: string; butler?: string; json?: boolean }) => {
      await withProject(options, async (projectId) => {
        const data = (await callButler(projectId, "/profile", { method: "POST", body: { profile: name }, butler: options.butler })) as {
          ok: boolean; profile: string; active: boolean;
        };
        printJsonOrSummary(
          data,
          `Profile set to "${data.profile || "(global default)"}" — session restarted.`,
          options.json,
        );
      });
    });

  butler
    .command("state")
    .description("Print the butler's current state (model, profile, context usage).")
    .option("-p, --project <id>", "Project ID (defaults to active project)")
    .option("-b, --butler <id>", "Which butler (definition id; defaults to the default butler)")
    .option("--json", "Output the raw JSON response")
    .action(async (options: { project?: string; butler?: string; json?: boolean }) => {
      await withProject(options, async (projectId) => {
        const data = (await callButler(projectId, "", { butler: options.butler })) as {
          active: boolean;
          sessionId: string | null;
          contextTokens?: number;
          contextWindow?: number;
          model?: string;
          mcpConnected?: boolean;
          selectedModel?: string;
          selectedProfile?: string;
        };
        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        const ctx = data.contextTokens != null && data.contextWindow
          ? `${data.contextTokens}/${data.contextWindow}`
          : "n/a";
        console.log(`Active:           ${data.active}`);
        console.log(`Session ID:       ${data.sessionId ?? "n/a"}`);
        console.log(`Model (live):     ${data.model ?? "n/a"}`);
        console.log(`Selected model:   ${data.selectedModel || "(profile default)"}`);
        console.log(`Selected profile: ${data.selectedProfile || "(global default)"}`);
        console.log(`Context usage:    ${ctx} tokens`);
        console.log(`MCP connected:    ${data.mcpConnected ?? "n/a"}`);
      });
    });

  butler
    .command("list")
    .description("List the defined butlers and this project's warm state for each.")
    .option("-p, --project <id>", "Project ID (defaults to active project)")
    .option("--json", "Output the raw JSON response")
    .action(async (options: { project?: string; json?: boolean }) => {
      await withProject(options, async (projectId) => {
        const url = `http://127.0.0.1:${SERVER_PORT}/api/projects/${projectId}/butlers`;
        const res = await fetch(url).catch(() => null);
        if (!res || !res.ok) {
          console.error(`Failed to list butlers — is the dev server running on port ${SERVER_PORT}?`);
          process.exit(1);
        }
        const data = (await res.json()) as { butlers: { id: string; name: string; model: string; active: boolean; contextTokens: number }[] };
        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        for (const b of data.butlers) {
          const dot = b.active ? "●" : "○";
          const ctx = b.active && b.contextTokens ? ` (${Math.round(b.contextTokens / 1000)}k)` : "";
          console.log(`${dot} ${b.id.padEnd(16)} ${b.name.padEnd(16)} ${b.model || "(profile default)"}${ctx}`);
        }
      });
    });

  const skill = butler
    .command("skill")
    .description("Read or write the project-scoped butler skill prompt.");

  skill
    .command("get")
    .description("Print the butler's current prompt (project override if any, else the global default).")
    .option("-p, --project <id>", "Project ID (defaults to active project)")
    .option("--json", "Output the raw JSON response")
    .action(async (options: { project?: string; json?: boolean }) => {
      await withProject(options, async (projectId) => {
        const data = (await callButler(projectId, "/skill")) as { prompt: string; isOverride: boolean };
        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log(`# Butler skill (${data.isOverride ? "project override" : "global default"})\n`);
        console.log(data.prompt);
      });
    });

  skill
    .command("set <prompt>")
    .description("Set the project-scoped butler prompt. Pass an empty string to remove the override.")
    .option("-p, --project <id>", "Project ID (defaults to active project)")
    .option("--json", "Output the raw JSON response")
    .action(async (prompt: string, options: { project?: string; json?: boolean }) => {
      await withProject(options, async (projectId) => {
        const data = (await callButler(projectId, "/skill", { method: "PUT", body: { prompt } })) as {
          ok: boolean; isOverride: boolean;
        };
        printJsonOrSummary(
          data,
          data.isOverride ? "Project butler skill saved." : "Project butler override cleared (using global default).",
          options.json,
        );
      });
    });
}
