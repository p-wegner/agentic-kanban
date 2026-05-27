import type { Command } from "commander";
import { db } from "../../db/index.js";
import { preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";

const SERVER_PORT = Number(process.env.SERVER_PORT) || Number(process.env.KANBAN_SERVER_PORT) || 3001;

async function resolveProjectId(explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  const rows = await db.select().from(preferences).where(eq(preferences.key, "active_project")).limit(1);
  return rows[0]?.value || null;
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
    .option("-t, --timeout <seconds>", "Max seconds to wait for the answer", "120")
    .option("--json", "Output the raw JSON response")
    .addHelpText("after", `
Examples:
  $ agentic-kanban butler ask "What does this project do?"
  $ agentic-kanban butler ask "Summarize the open issues" --json
`)
    .action(async (question: string[], options: { project?: string; timeout?: string; json?: boolean }) => {
      const projectId = await resolveProjectId(options.project);
      if (!projectId) {
        console.error("No active project. Pass --project <id> or set an active project first.");
        process.exit(1);
      }
      const content = question.join(" ").trim();
      if (!content) {
        console.error("Question is empty.");
        process.exit(1);
      }
      const timeoutMs = (Number(options.timeout) || 120) * 1000;
      try {
        const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/projects/${projectId}/butler/ask`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, timeoutMs }),
        });
        const data = (await res.json()) as AskResponse;
        if (!res.ok) {
          console.error(`Butler error: ${data.error ?? res.statusText}`);
          process.exit(1);
        }
        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(data.text);
        }
      } catch (err) {
        console.error(`Failed to reach the butler — is the dev server running on port ${SERVER_PORT}?`);
        console.error(`  ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      } finally {
        process.exit(0);
      }
    });
}
