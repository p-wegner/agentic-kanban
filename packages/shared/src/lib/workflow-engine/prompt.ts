import type { WorkflowNodeRow, TransitionTarget } from "./types.js";
import { getNodeGuidance, isSpecPlanningStageName } from "./node-config.js";

/**
 * Render the block injected into the agent prompt describing where it is in the
 * workflow and how to advance. Returns "" when there is no active workflow.
 */
export function buildTransitionBlock(
  node: WorkflowNodeRow,
  transitions: TransitionTarget[],
  workspaceId?: string,
): string {
  const guidance = getNodeGuidance(node.config);
  const wsArg = workspaceId ? `workspaceId: "${workspaceId}", ` : "workspaceId, ";
  const lines: string[] = [];
  lines.push("## Workflow");
  lines.push(
    `You are at the **${node.name}** stage of this issue's workflow. The board status reflects this stage automatically.`,
  );
  if (guidance) lines.push("", guidance);

  // A fork node is a control point: the server spawns the parallel branches
  // automatically. The agent that arrives here has nothing further to do.
  if (node.nodeType === "parallel-fork") {
    lines.push(
      "",
      "This is a **parallel fork**. The system will now spawn the parallel branches automatically — you do NOT need to call `propose_transition`. Your work at this stage is complete; stop here.",
    );
    return lines.join("\n");
  }

  if (isSpecPlanningStageName(node.name)) {
    lines.push(
      "",
      "This is an interactive planning phase. Draft or refine the phase artifact and ask clarifying questions when needed, then stop. Do NOT call `propose_transition`; the user advances this phase from the planning panel with **Approve & continue**.",
    );
    if (transitions.length > 0) {
      lines.push("", "The next phase options shown to the user are:");
      for (const t of transitions) {
        const why = t.label ? ` - ${t.label}` : "";
        lines.push(`- **${t.toNodeName}**${why}`);
      }
    }
    return lines.join("\n");
  }

  if (transitions.length === 0) {
    lines.push("", "This is a terminal stage — there are no further transitions.");
  } else {
    lines.push("", "When this stage's work is complete, advance the workflow by calling the MCP tool:");
    lines.push(`\`propose_transition({ ${wsArg}toNodeName, summary })\``);
    lines.push("", "Valid next stages from here:");
    const hasConditions = transitions.some((t) => t.condition !== "manual");
    for (const t of transitions) {
      const cond = t.condition === "manual" ? "" : ` _(condition: ${t.condition})_`;
      const why = t.label ? ` — ${t.label}` : "";
      lines.push(`- **${t.toNodeName}**${why}${cond}`);
    }
    if (hasConditions) {
      lines.push(
        "",
        "Some edges are condition-gated. If you ran tests, pass `testsPassed: true|false` and you may omit `toNodeName` to let the workflow auto-route (e.g. tests_pass → review, tests_fail → fix). Diff-based conditions (diff_clean, diff_touches) are evaluated automatically from your committed changes.",
      );
    }
    lines.push(
      "",
      "Do not move the issue with `move_issue`; use `propose_transition` so the workflow stays consistent.",
    );
  }
  return lines.join("\n");
}
