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

function toExportJson(graph: any) {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    metadata: {
      id: graph.id,
      name: graph.name,
      description: graph.description ?? null,
      ticketType: graph.ticketType ?? null,
      isDefault: !!graph.isDefault,
      isBuiltin: !!graph.isBuiltin,
      builtinKey: graph.builtinKey ?? null,
      projectId: graph.projectId ?? null,
      createdAt: graph.createdAt,
      updatedAt: graph.updatedAt,
    },
    nodes: graph.nodes ?? [],
    edges: graph.edges ?? [],
  };
}

function normalizeImportedTemplate(input: any) {
  const source = input?.template ?? input?.workflow ?? input;
  const metadata = source?.metadata ?? source ?? {};
  return {
    name: input?.name ?? source?.name ?? metadata.name,
    description: input?.description ?? source?.description ?? metadata.description ?? null,
    ticketType: input?.ticketType ?? source?.ticketType ?? metadata.ticketType ?? null,
    isDefault: input?.isDefault ?? source?.isDefault ?? metadata.isDefault ?? false,
    nodes: source?.nodes ?? [],
    edges: source?.edges ?? [],
  };
}

function validateImportedTemplate(spec: ReturnType<typeof normalizeImportedTemplate>): string[] {
  const errors: string[] = [];
  if (typeof spec.name !== "string" || spec.name.trim().length === 0) {
    errors.push("Imported workflow name is required.");
  }
  if (!Array.isArray(spec.nodes)) {
    errors.push("Imported workflow nodes must be an array.");
  } else {
    spec.nodes.forEach((node, index) => {
      if (!node || typeof node !== "object") {
        errors.push(`Imported workflow node at index ${index} must be an object.`);
        return;
      }
      if (typeof node.id !== "string" || node.id.trim().length === 0) {
        errors.push(`Imported workflow node at index ${index} must have a non-empty string id.`);
      }
      if (typeof node.nodeType !== "string" || node.nodeType.trim().length === 0) {
        errors.push(`Imported workflow node at index ${index} must have a non-empty string nodeType.`);
      }
    });
  }
  if (!Array.isArray(spec.edges)) {
    errors.push("Imported workflow edges must be an array.");
  } else {
    spec.edges.forEach((edge, index) => {
      if (!edge || typeof edge !== "object") {
        errors.push(`Imported workflow edge at index ${index} must be an object.`);
        return;
      }
      if (typeof edge.fromNodeId !== "string" || edge.fromNodeId.trim().length === 0) {
        errors.push(`Imported workflow edge at index ${index} must have a non-empty string fromNodeId.`);
      }
      if (typeof edge.toNodeId !== "string" || edge.toNodeId.trim().length === 0) {
        errors.push(`Imported workflow edge at index ${index} must have a non-empty string toNodeId.`);
      }
    });
  }
  return errors;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, ""));
}

export function registerWorkflowCommand(program: Command) {
  const wf = program
    .command("workflow")
    .description("Manage configurable workflow templates (graphs of stages + transitions).\n\nSubcommands: list, get, export, create, import, delete");

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
    .command("export <templateId>")
    .description("Print a workflow template's importable JSON (metadata + nodes + edges).")
    .action(async (templateId: string) => {
      try {
        await runMigrations();
        const g = await getTemplateGraph(db, templateId);
        if (!g) {
          console.error(`Template ${templateId} not found`);
          process.exit(1);
        }
        console.log(JSON.stringify(toExportJson(g), null, 2));
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
        const spec = readJsonFile(jsonFile) as any;
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
    .command("import <jsonFile>")
    .description("Import a workflow template JSON file into the active project as a new template.")
    .action(async (jsonFile: string) => {
      try {
        await runMigrations();
        const projectId = await getActiveProjectId();
        const spec = normalizeImportedTemplate(readJsonFile(jsonFile));
        const importErrors = validateImportedTemplate(spec);
        if (importErrors.length > 0) {
          console.error("Invalid workflow import:");
          for (const e of importErrors) console.error("  - " + e);
          process.exit(1);
        }
        const res = await createWorkflowTemplate(db, {
          projectId,
          name: spec.name.trim(),
          description: spec.description,
          ticketType: spec.ticketType ?? null,
          isDefault: spec.isDefault,
          nodes: spec.nodes,
          edges: spec.edges,
        });
        if (!res.ok) {
          console.error("Invalid workflow graph:");
          for (const e of res.errors) console.error("  - " + e);
          process.exit(1);
        }
        console.log(`Imported workflow template: ${spec.name}`);
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
