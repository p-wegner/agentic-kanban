import type { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { runMigrations, resolveProjectIdArg } from "../shared.js";
import { buildApiUrl } from "./workspace-api-url.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

const apiBase = () => buildApiUrl("", "/api");

/**
 * `pnpm cli -- backlog export|import` — Backlog Markdown (docs/backlog-markdown.md).
 * Both go through the live server (export reuses the snapshot machinery; import writes through
 * the issue service so events/webhooks fire), so the server must be up — like `tag`.
 */
export function registerBacklogCommand(program: Command) {
  const cmd = program.command("backlog").description("Backlog as ONE markdown file — export with filters, import (standard or liberal markdown) with a dry-run preview.\n\nSubcommands: export, import");

  cmd
    .command("export")
    .description("Export the project's backlog as Backlog Markdown (kanban-md 1) to stdout or --out <file>.")
    .option("--project <idOrName>", "Target project by id or name (default: the active project)")
    .option("--out <file>", "Write to this file instead of stdout (e.g. BACKLOG.md)")
    .option("--status <names>", "Comma-separated status names to include (default: every non-terminal status)")
    .option("--include-done", "Include Done/Cancelled/Archived")
    .option("--tag <names>", "Comma-separated tags (any match)")
    .option("--priority <names>", "Comma-separated priorities")
    .option("--type <names>", "Comma-separated issue types")
    .option("--milestone <name>", "Only this milestone")
    .option("--q <text>", "Free-text filter over title + description")
    .option("--since <iso>", "Only issues updated at/after this ISO date")
    .option("--numbers <list>", "Comma-separated issue numbers")
    .option("--no-timestamps", "Omit created/updated dates")
    .option("--no-deps", "Omit depends/blocks")
    .option("--bare", "Body only — no front matter/H1 (for pasting into an existing document)")
    .addHelpText("after", `
Examples:
  $ pnpm cli -- backlog export --out BACKLOG.md
  $ pnpm cli -- backlog export --status "Backlog,In Progress" --tag arch --out arch-backlog.md
  $ pnpm cli -- backlog export --project pantry --include-done | less`)
    .action(async (o: { project?: string; out?: string; status?: string; includeDone?: boolean; tag?: string; priority?: string; type?: string; milestone?: string; q?: string; since?: string; numbers?: string; timestamps?: boolean; deps?: boolean; bare?: boolean }) => {
      try {
        await runMigrations();
        const projectId = await resolveProjectIdArg(o.project);
        const p = new URLSearchParams({ download: "0" });
        if (o.status) p.set("status", o.status);
        if (o.includeDone) p.set("includeDone", "1");
        if (o.tag) p.set("tag", o.tag);
        if (o.priority) p.set("priority", o.priority);
        if (o.type) p.set("type", o.type);
        if (o.milestone) p.set("milestone", o.milestone);
        if (o.q) p.set("q", o.q);
        if (o.since) p.set("since", o.since);
        if (o.numbers) p.set("numbers", o.numbers);
        if (o.timestamps === false) p.set("timestamps", "0");
        if (o.deps === false) p.set("deps", "0");
        if (o.bare) p.set("bare", "1");
        const res = await fetch(`${apiBase()}/projects/${projectId}/backlog.md?${p.toString()}`);
        const text = await res.text();
        if (!res.ok) { console.error(`Error ${res.status}: ${text}`); process.exit(1); }
        if (o.out) { writeFileSync(o.out, text, "utf8"); console.error(`wrote ${o.out} (${text.split("\n### ").length - 1} issue(s))`); }
        else process.stdout.write(text);
        process.exit(0);
      } catch (err) { console.error(`Error: ${errorMessage(err)}`); process.exit(1); }
    });

  cmd
    .command("import <file>")
    .description("Import a markdown backlog (kanban-md standard or liberal `## Section` + `- [ ] item` styles). Dry-run preview by default; --apply writes.")
    .option("--project <idOrName>", "Target project by id or name (default: the active project)")
    .option("--apply", "Actually create/update issues (default: preview only)")
    .option("--mode <mode>", "update (default: match existing by #number/key/title and update fields present in the file) | create (everything new)")
    .option("--match-by <how>", "auto | number | key | title | none (update mode)")
    .option("--default-status <name>", "Status for issues above any section")
    .option("--unknown-status <how>", "create (default) | map — sections the project lacks")
    .option("--json", "Emit the preview/result as JSON")
    .addHelpText("after", `
Examples:
  $ pnpm cli -- backlog import BACKLOG.md                 # preview: what would be created/updated
  $ pnpm cli -- backlog import BACKLOG.md --apply
  $ pnpm cli -- backlog import other-tool-export.md --mode create --apply --project pantry`)
    .action(async (file: string, o: { project?: string; apply?: boolean; mode?: string; matchBy?: string; defaultStatus?: string; unknownStatus?: string; json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = await resolveProjectIdArg(o.project);
        const text = readFileSync(file, "utf8");
        const path = o.apply ? "import" : "preview";
        const res = await fetch(`${apiBase()}/projects/${projectId}/backlog.md/${path}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, mode: o.mode, matchBy: o.matchBy, defaultStatus: o.defaultStatus, unknownStatus: o.unknownStatus }),
        });
        const data = (await res.json()) as {
          error?: string; format?: string; confidence?: number; sameProject?: boolean; lowConfidence?: boolean;
          rows?: Array<{ action: string; number: number | null; matchedNumber: number | null; title: string; status: string; priority: string; changes: string[] }>;
          counts?: Record<string, number>; statusesToCreate?: string[]; tagsToCreate?: string[]; warnings?: string[];
          created?: number; updated?: number; unchanged?: number; createdTags?: string[]; createdStatuses?: string[]; createdDependencies?: number;
        };
        if (!res.ok) { console.error(`Error ${res.status}: ${JSON.stringify(data)}`); process.exit(1); }
        if (o.json) { console.log(JSON.stringify(data, null, 2)); process.exit(0); }
        if (!o.apply) {
          const rows = data.rows ?? [];
          const counts = data.counts ?? {};
          console.log(`preview (${data.format ?? "?"}, confidence ${Number(data.confidence ?? 0).toFixed(2)}${data.sameProject ? ", same project" : ""}) — create ${counts.create ?? 0} · update ${counts.update ?? 0} · unchanged ${counts.unchanged ?? 0}`);
          for (const r of rows) console.log(`  ${r.action.padEnd(9)} ${r.matchedNumber != null ? "#" + r.matchedNumber : r.number != null ? "(#" + r.number + ")" : "new"}`.padEnd(22) + ` ${r.title.slice(0, 70).padEnd(70)} ${r.status} ${r.priority}${r.changes.length ? "  [" + r.changes.join(", ") + "]" : ""}`);
          const extra: string[] = [];
          if (data.statusesToCreate?.length) extra.push(`statuses to create: ${data.statusesToCreate.join(", ")}`);
          if (data.tagsToCreate?.length) extra.push(`tags to create: ${data.tagsToCreate.join(", ")}`);
          if (extra.length) console.log(extra.join(" · "));
          for (const w of data.warnings ?? []) console.log(`  ! ${w}`);
          if (data.lowConfidence) console.log("  ! low confidence — consider having an agent normalise the file first (skill: backlog-markdown)");
          console.log("re-run with --apply to write.");
        } else {
          console.log(`created ${data.created ?? 0} · updated ${data.updated ?? 0} · unchanged ${data.unchanged ?? 0}` +
            `${data.createdTags?.length ? ` · tags +${data.createdTags.join(",")}` : ""}` +
            `${data.createdStatuses?.length ? ` · statuses +${data.createdStatuses.join(",")}` : ""}` +
            `${data.createdDependencies ? ` · deps +${data.createdDependencies}` : ""}`);
          for (const w of data.warnings ?? []) console.log(`  ! ${w}`);
        }
        process.exit(0);
      } catch (err) { console.error(`Error: ${errorMessage(err)}`); process.exit(1); }
    });
}
