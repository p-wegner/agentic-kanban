import { db } from "./index.js";
import { tags, agentSkills } from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

async function seed() {
  const now = new Date().toISOString();

  // Seed default tags (global, not project-scoped)
  const existingTags = await db.select().from(tags).limit(1);
  if (existingTags.length > 0) {
    console.log("Tags already seeded, skipping.");
  } else {
    const DEFAULT_TAGS = [
      { name: "bug", color: "#EF4444" },
      { name: "feature", color: "#3B82F6" },
      { name: "improvement", color: "#8B5CF6" },
      { name: "docs", color: "#10B981" },
    ];
    for (const tag of DEFAULT_TAGS) {
      await db.insert(tags).values({
        id: randomUUID(),
        name: tag.name,
        color: tag.color,
        createdAt: now,
      });
    }
    console.log(`Seeded ${DEFAULT_TAGS.length} default tags.`);
  }

  // Seed default agent skills
  const existingSkills = await db.select().from(agentSkills).limit(1);
  if (existingSkills.length > 0) {
    console.log("Agent skills already seeded, skipping.");
  } else {
    const DEFAULT_SKILLS = [
      {
        name: "board-navigator",
        description: "Comprehensive guide for agents to interact with the kanban board using MCP tools",
        prompt: `You are an agent working on a kanban board. You have access to MCP tools (prefix: mcp__agentic-kanban__) to interact with the board.

## Available Tools
- get_context — see active project, issue counts, running workspaces
- list_issues — list issues (filter by status, priority, tag)
- get_issue — get full issue details including workspaces and dependencies
- create_issue / update_issue / delete_issue — issue CRUD
- move_issue — move issue to a different status column
- list_workspaces / start_workspace / stop_workspace — workspace management
- get_workspace_diff — view git diff for a workspace
- merge_workspace / close_workspace — finalize work
- list_tags / create_tag — tag management
- list_sessions / read_terminal / get_session_stats — session monitoring
- get_diff_comments / create_diff_comment — code review
- add_dependency / remove_dependency — issue dependency management
- list_agent_skills / get_agent_skill — discover available skills

## Workflow Rules
1. Move to "In Progress" before starting any code changes
2. Use description field as a shared progress log — update it with blockers, decisions, scope changes
3. Commit all changes before moving to "In Review"
4. "Done" means done — code committed, tests pass, review approved
5. Use "Cancelled" for abandoned or superseded work with an explanation

## Status Names (exact strings)
Todo → In Progress → In Review → AI Reviewed → Done / Cancelled

## Priority Values
"low" | "medium" | "high" | "critical"

## Board Operations
- Always prefer MCP tools over direct API calls
- Update the board in real-time as you work — don't batch updates
- If blocked, update the issue description and set priority to "high"
- For large issues, create sub-issues and track them independently`,
        model: null,
      },
      {
        name: "code-review",
        description: "Default AI code review prompt — customize per project to change review behavior",
        prompt: `You are an AI code reviewer. Review the changes on branch '{{branch}}'.
Run 'git diff {{baseBranch}}' to see the diff.

Review for: correctness bugs, security vulnerabilities, logic errors, and missing error handling.
Classify each issue as CRITICAL (must fix — bugs, security, data loss), MAJOR (should fix — broken edge cases, poor error handling), or MINOR (nice to have — style, naming).

{{autoFixInstructions}}

Do NOT move the issue to 'AI Reviewed' yourself — the system handles that on merge.

Issue ID: {{issueId}}`,
        model: null,
      },
      {
        name: "dependency-analyzer",
        description: "Analyze a ticket and its relationships to other open tickets, suggest dependency updates",
        prompt: `Analyze the given issue and its relationship to other open (non-Done, non-Cancelled) issues on the board.

Steps:
1. Use get_issue to read the full details of the target issue
2. Use list_issues to get all open issues (filter out Done and Cancelled)
3. Analyze the titles and descriptions for:
   - Shared code areas or files
   - Sequential dependencies (X must be done before Y)
   - Related functionality that could conflict
4. Use add_dependency to create any discovered "depends on" relationships
5. Use update_issue to add a "## Dependencies" section to the issue description listing discovered relationships

Focus on actionable dependencies, not just topical similarity. Only add a dependency if there is a clear technical reason the issues are coupled.`,
        model: "haiku",
      },
      {
        name: "ticket-enhancer",
        description: "Enhance a ticket's title and description for clarity and completeness",
        prompt: `Review and enhance the given issue to make it more actionable for an AI agent.

Steps:
1. Use get_issue to read the current title and description
2. Analyze for clarity, completeness, and actionability:
   - Is the title descriptive enough? Rewrite if vague.
   - Does the description include: what to implement, acceptance criteria, relevant files/areas?
   - Are there implicit requirements that should be made explicit?
3. Use update_issue to save the improved title and/or description
4. Keep the original intent — enhance, don't redesign

Format the description with clear sections:
- What needs to be done
- Why it matters (context)
- Acceptance criteria (if inferable)
- Relevant files or areas (if inferable from the title/context)`,
        model: "haiku",
      },
    ];

    for (const skill of DEFAULT_SKILLS) {
      await db.insert(agentSkills).values({
        id: randomUUID(),
        name: skill.name,
        description: skill.description,
        prompt: skill.prompt,
        model: skill.model,
        isBuiltin: true,
        createdAt: now,
        updatedAt: now,
      });
    }
    console.log(`Seeded ${DEFAULT_SKILLS.length} default agent skills.`);
  }

  console.log('Run `pnpm cli -- register <path>` to register a git repo as a project.');
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
