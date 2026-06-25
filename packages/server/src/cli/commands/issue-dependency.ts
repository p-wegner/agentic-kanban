// Issue CLI: the `issue dependency` subcommand group (list / add / remove / analyze /
// update-batch). Extracted verbatim from issue.ts (#859 CLI god-file split) and registered
// onto the same issueCmd so `pnpm cli -- issue dependency <sub>` is unchanged. Thin
// transport over the repository layer (no inline db; lint:arch cli-not-down-to-persistence).
import type { Command } from "commander";
import type { DependencyType } from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runMigrations, getActiveProjectId } from "../shared.js";
import { getIssueIdByNumberInProject, getOutgoingDependencies, getIncomingDependencies } from "../../repositories/issue.repository.js";
import {
  getIssueIdsAndProjectsForBatch,
  getDependencyRowsForProjects,
  getIssueProjectIdsPair,
  insertDependency,
  getDependencyEdge,
  deleteDependencyByIdReturning,
  applyDependencyEdgeBatch,
} from "../../repositories/issue-service.repository.js";
import { validateBatchEdges, formatBatchEdgeResult } from "../../lib/dependency-batch.js";

export function registerIssueDependencyCommands(issueCmd: Command) {
  // ── dependency sub-commands ──
  const depCmd = issueCmd.command("dependency").description("Manage issue dependencies.\n\nDependencies link issues together with typed relationships. Available types: depends_on, blocked_by, related_to, duplicates, parent_of, child_of.\n\nSubcommands: list, add, remove");

  depCmd
    .command("list <issue-id>")
    .description("List dependencies for an issue.\n\nShows both outgoing (this issue depends on others) and incoming (others depend on this issue) dependencies.")
    .addHelpText("after", `
Example:
  $ agentic-kanban issue dependency list abc123-def456-...
`)
    .action(async (issueId: string) => {
      try {
        await runMigrations();

        const outgoing = await getOutgoingDependencies(issueId);
        const incoming = await getIncomingDependencies(issueId);

        if (outgoing.length === 0 && incoming.length === 0) {
          console.log("No dependencies found.");
          process.exit(0);
        }

        if (outgoing.length > 0) {
          console.log("Outgoing:");
          for (const dep of outgoing) {
            const num = dep.issueNumber != null ? `#${dep.issueNumber}` : "(no number)";
            console.log(`  [${dep.type}] ${num} ${dep.issueTitle} (${dep.issueStatusName})`);
            console.log(`    id: ${dep.id}`);
          }
        }

        if (incoming.length > 0) {
          console.log("Incoming:");
          for (const dep of incoming) {
            const num = dep.issueNumber != null ? `#${dep.issueNumber}` : "(no number)";
            console.log(`  [${dep.type}] ${num} ${dep.issueTitle} (${dep.issueStatusName})`);
            console.log(`    id: ${dep.id}`);
          }
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  depCmd
    .command("add <issue-id> <target-id>")
    .description("Add a dependency between two issues.\n\nCreates a typed link from <issue-id> to <target-id>. Both issues must belong to the same project. Self-dependencies and duplicate links are rejected.")
    .option("-t, --type <type>", "Dependency type: depends_on, blocked_by, related_to, duplicates, parent_of, child_of (default: depends_on)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban issue dependency add abc123 def456                       # abc123 depends_on def456
  $ agentic-kanban issue dependency add abc123 def456 -t blocked_by         # abc123 is blocked_by def456
  $ agentic-kanban issue dependency add abc123 def456 -t parent_of          # abc123 is parent_of def456
`)
    .action(async (issueId: string, targetId: string, options: { type?: string }) => {
      try {
        await runMigrations();

        const depType = options.type || "depends_on";
        const validTypes = ["depends_on", "blocked_by", "related_to", "duplicates", "parent_of", "child_of", "coupled_with"];
        if (!validTypes.includes(depType)) {
          console.error(`Invalid type '${depType}'. Valid types: ${validTypes.join(", ")}`);
          process.exit(1);
        }

        if (issueId === targetId) {
          console.error("An issue cannot depend on itself.");
          process.exit(1);
        }

        const [sourceIssue, targetIssue] = await getIssueProjectIdsPair(issueId, targetId);

        if (sourceIssue.length === 0) {
          console.error(`Issue '${issueId}' not found.`);
          process.exit(1);
        }
        if (targetIssue.length === 0) {
          console.error(`Issue '${targetId}' not found.`);
          process.exit(1);
        }
        if (sourceIssue[0].projectId !== targetIssue[0].projectId) {
          console.error("Cannot add dependencies across projects.");
          process.exit(1);
        }

        // Detect duplicates BEFORE inserting. The unique key is
        // (issueId, dependsOnId, type). Matching the insert error string is not
        // portable — libsql's message lacks "UNIQUE constraint" (#857).
        if (await getDependencyEdge(issueId, targetId, depType as DependencyType)) {
          console.error("This dependency already exists.");
          process.exit(1);
        }

        const id = randomUUID();
        try {
          await insertDependency({
            id,
            issueId,
            dependsOnId: targetId,
            type: depType as DependencyType,
            createdAt: new Date().toISOString(),
          });
        } catch (err) {
          // A concurrent insert could still race the pre-check. Re-query instead
          // of string-matching the driver error to stay driver-independent.
          if (await getDependencyEdge(issueId, targetId, depType as DependencyType)) {
            console.error("This dependency already exists.");
            process.exit(1);
          }
          throw err;
        }

        console.log(`Added '${depType}' dependency: ${issueId} -> ${targetId}`);
        console.log(`  id: ${id}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  depCmd
    .command("remove <dependency-id>")
    .description("Remove a dependency by its ID.\n\nUse 'issue dependency list' to find the dependency ID.")
    .addHelpText("after", `
Example:
  $ agentic-kanban issue dependency list abc123  # find the dependency ID
  $ agentic-kanban issue dependency remove dep-abc-def
`)
    .action(async (dependencyId: string) => {
      try {
        await runMigrations();

        const removedCount = await deleteDependencyByIdReturning(dependencyId);
        if (removedCount === 0) {
          console.error(`Dependency '${dependencyId}' not found.`);
          process.exit(1);
        }

        console.log(`Removed dependency '${dependencyId}'.`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  depCmd
    .command("analyze <issue-number>")
    .description("Analyze dependencies for an issue against the current board.\n\nCalls the server's dependency-analysis endpoint to infer and create dependency edges. Requires the dev server to be running.")
    .option("--json", "Output raw JSON instead of formatted text")
    .addHelpText("after", `
Examples:
  $ agentic-kanban issue dependency analyze 42
  $ agentic-kanban issue dependency analyze 42 --json
`)
    .action(async (issueNumberArg: string, options: { json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = await getActiveProjectId();

        const num = Number(issueNumberArg);
        if (!Number.isInteger(num) || num <= 0) {
          console.error(`Invalid issue number: ${issueNumberArg}`);
          process.exit(1);
        }

        const issueId = await getIssueIdByNumberInProject(num, projectId);

        if (!issueId) {
          console.error(`Issue #${num} not found in active project.`);
          process.exit(1);
        }

        const port = process.env.KANBAN_SERVER_PORT ?? "3001";
        const res = await fetch(`http://127.0.0.1:${port}/api/issues/analyze-dependencies`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ issueId, projectId }),
        });
        const text = await res.text();
        if (!res.ok) {
          console.error(`Dependency analysis failed (${res.status}): ${text}`);
          process.exit(1);
        }

        if (options.json) {
          console.log(text);
        } else {
          try {
            const parsed: unknown = JSON.parse(text);
            console.log(JSON.stringify(parsed, null, 2));
          } catch {
            console.log(text);
          }
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  depCmd
    .command("update-batch <jsonFile>")
    .description("Add or remove multiple dependency edges atomically from a JSON file.\n\nReads a JSON file containing an array of edge operations. Idempotent: existing adds and missing removes are skipped. Cycle detection is applied; rolls back on cycle.")
    .option("--json", "Output raw JSON instead of formatted text")
    .addHelpText("after", `
Examples:
  $ agentic-kanban issue dependency update-batch edges.json
  $ agentic-kanban issue dependency update-batch edges.json --json

JSON file format:
  [
    { "issueId": "<uuid>", "dependsOnId": "<uuid>", "type": "depends_on", "action": "add" },
    { "issueId": "<uuid>", "dependsOnId": "<uuid>", "type": "blocked_by", "action": "remove" }
  ]

Valid types: depends_on, blocked_by, related_to, duplicates, parent_of, child_of
Valid actions: add, remove
`)
    .action(async (jsonFile: string, options: { json?: boolean }) => {
      try {
        await runMigrations();

        let fileContent: string;
        try {
          fileContent = readFileSync(jsonFile, "utf8");
        } catch (err) {
          console.error(`Could not read file '${jsonFile}': ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }

        let edges: Array<{ issueId: string; dependsOnId: string; type?: string; action: "add" | "remove" }>;
        try {
          edges = JSON.parse(fileContent) as Array<{ issueId: string; dependsOnId: string; type?: string; action: "add" | "remove" }>;
        } catch {
          console.error("Invalid JSON in file.");
          process.exit(1);
        }

        if (!Array.isArray(edges)) {
          console.error("JSON file must contain an array of edge operations.");
          process.exit(1);
        }

        const VALID_TYPES = ["depends_on", "blocked_by", "related_to", "duplicates", "parent_of", "child_of", "coupled_with"] as const;
        const DIRECTIONAL = new Set<string>(["depends_on", "blocked_by", "parent_of", "child_of"]);

        const validationError = validateBatchEdges(edges, VALID_TYPES);
        if (validationError) {
          console.error(validationError);
          process.exit(1);
        }

        const issueIds = [...new Set(edges.flatMap((e) => [e.issueId, e.dependsOnId]))];
        const issueRows = issueIds.length === 0 ? [] : await getIssueIdsAndProjectsForBatch(issueIds);
        const projectByIssue = new Map(issueRows.map((r) => [r.id, r.projectId]));

        const projectIds = [...new Set(issueRows.map((r) => r.projectId))];
        const allDepRows = projectIds.length === 0 ? [] : await getDependencyRowsForProjects(projectIds);

        const adjByProject = new Map<string, Map<string, Set<string>>>();
        const edgeKeyToRow = new Map<string, { id: string; projectId: string }>();
        for (const dep of allDepRows) {
          if (DIRECTIONAL.has(dep.type)) {
            let adj = adjByProject.get(dep.projectId);
            if (!adj) { adj = new Map(); adjByProject.set(dep.projectId, adj); }
            let set = adj.get(dep.issueId);
            if (!set) { set = new Set(); adj.set(dep.issueId, set); }
            set.add(dep.dependsOnId);
          }
          edgeKeyToRow.set(`${dep.issueId}|${dep.dependsOnId}|${dep.type}`, { id: dep.id, projectId: dep.projectId });
        }

        const { added, removed, skipped, cycleError } = await applyDependencyEdgeBatch({
          edges,
          projectByIssue,
          adjByProject,
          edgeKeyToRow,
          directional: DIRECTIONAL,
        });

        if (cycleError) {
          console.error(`Error: ${cycleError}`);
          process.exit(1);
        }

        const result = { added, removed, skipped };
        for (const line of formatBatchEdgeResult(result, options.json ?? false)) {
          console.log(line);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
