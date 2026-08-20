import type { Command } from "commander";
import { cliAction } from "../shared.js";
import { buildApiUrl } from "./workspace-api-url.js";

const apiBase = () => buildApiUrl("", "/api");

interface TagRow {
  id: string;
  name: string;
  color: string | null;
}

export function registerTagCommand(program: Command) {
  const tagCmd = program.command("tag").description("Manage tags (labels) for categorizing issues.\n\nSubcommands: list, create");

  // ── list ─────────────────────────────────────────────────────────────────
  tagCmd
    .command("list")
    .description("List all available tags.")
    .option("--json", "Emit machine-readable JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ pnpm cli -- tag list
  $ pnpm cli -- tag list --json`,
    )
    .action(cliAction(async (options: { json?: boolean }) => {
      const res = await fetch(`${apiBase()}/tags`);
      if (!res.ok) {
        const text = await res.text();
        console.error(`Error ${res.status}: ${text}`);
        process.exit(1);
      }
      const tags = (await res.json()) as TagRow[];
      if (options.json) {
        console.log(JSON.stringify(tags, null, 2));
      } else {
        if (tags.length === 0) {
          console.log("No tags found.");
        } else {
          for (const t of tags) {
            const colorPart = t.color ? `  ${t.color}` : "";
            console.log(`${t.id}  ${t.name}${colorPart}`);
          }
        }
      }
      process.exit(0);
    }));

  // ── create ───────────────────────────────────────────────────────────────
  tagCmd
    .command("create <name>")
    .description("Create a new tag.")
    .option("--color <color>", "Tag color as hex code (e.g., '#ff0000')")
    .option("--json", "Emit machine-readable JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ pnpm cli -- tag create bug
  $ pnpm cli -- tag create feature --color '#00ff00'
  $ pnpm cli -- tag create enhancement --color '#0000ff' --json`,
    )
    .action(cliAction(async (name: string, options: { color?: string; json?: boolean }) => {
      const body: Record<string, string> = { name };
      if (options.color) body.color = options.color;

      const res = await fetch(`${apiBase()}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        console.error(`Error ${res.status}: ${text}`);
        process.exit(1);
      }
      const tag = (await res.json()) as TagRow;
      if (options.json) {
        console.log(JSON.stringify(tag, null, 2));
      } else {
        console.log(`Tag created: ${tag.id}`);
        console.log(`  Name:  ${tag.name}`);
        if (tag.color) console.log(`  Color: ${tag.color}`);
      }
      process.exit(0);
    }));
}
