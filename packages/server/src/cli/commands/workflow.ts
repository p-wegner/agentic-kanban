import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { db } from "../../db/index.js";
import {
  listWorkflowTemplates,
  getTemplateGraph,
  createWorkflowTemplate,
  deleteWorkflowTemplate,
} from "@agentic-kanban/shared/lib/workflow-engine";
import { runMigrations, getActiveProjectId } from "../shared.js";

export function registerWorkflowCommand(program: Command) {
  const wf = program
    .command("workflow")
    .description("Manage configurable workflow templates (graphs of stages + transitions).\n\nSubcommands: list, get, create, delete");

  wf
    .command("list")
    .description("List workflow templates for the active project (project-scoped + global built-ins).")
    .action(async () => {
      try {
        await runMigrations();
        const projectId = await getActiveProjectId();
        const tpls = await listWorkflowTemplates(db, projectId);
        if (tpls.length === 0) {
          console.log("No workflow templates.");
          process.exit(0);
        }
        for (const t of tpls) {
          const g = await getTemplateGraph(db, t.id);
          const tags = [t.isBuiltin ? "builtin" : "custom", t.ticketType ? `type:${t.ticketType}${t.isDefault ? "/default" : ""}` : null].filter(Boolean).join(", ");
          console.log(`  ${t.name}  [${tags}]  ${g?.nodes.length ?? 0} stages, ${g?.edges.length ?? 0} transitions`);
          console.log(`    id: ${t.id}`);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wf
    .command("get <templateId>")
    .description("Print a workflow template's full graph as JSON.")
    .action(async (templateId: string) => {
      try {
        await runMigrations();
        const g = await getTemplateGraph(db, templateId);
        if (!g) {
          console.error(`Template ${templateId} not found`);
          process.exit(1);
        }
        console.log(JSON.stringify(g, null, 2));
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wf
    .command("create <jsonFile>")
    .description("Create a workflow template from a JSON file: { name, description?, ticketType?, isDefault?, nodes:[{id,name,nodeType,statusName?,skillName?,maxVisits?,config?}], edges:[{fromNodeId,toNodeId,label?,condition?}] }")
    .action(async (jsonFile: string) => {
      try {
        await runMigrations();
        const projectId = await getActiveProjectId();
        const spec = JSON.parse(readFileSync(jsonFile, "utf-8"));
        const res = await createWorkflowTemplate(db, {
          projectId,
          name: spec.name,
          description: spec.description,
          ticketType: spec.ticketType ?? null,
          isDefault: spec.isDefault,
          nodes: spec.nodes ?? [],
          edges: spec.edges ?? [],
        });
        if (!res.ok) {
          console.error("Invalid workflow graph:");
          for (const e of res.errors) console.error("  - " + e);
          process.exit(1);
        }
        console.log(`Created workflow template: ${spec.name}`);
        console.log(`  id: ${res.id}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wf
    .command("delete <templateId>")
    .description("Delete a non-built-in workflow template.")
    .action(async (templateId: string) => {
      try {
        await runMigrations();
        const res = await deleteWorkflowTemplate(db, templateId);
        if (!res.ok) {
          console.error(res.error);
          process.exit(1);
        }
        console.log("Deleted.");
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
