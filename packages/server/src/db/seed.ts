import { db } from "./index.js";
import { tags, agentSkills } from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

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

  // Seed default agent skills — upsert by name so new builtins are added to existing DBs
  {
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
First, run 'git diff --stat {{baseBranch}}' to see an overview of changed files.
Then review each file individually with 'git diff {{baseBranch}} -- <filepath>' — do NOT dump the entire diff at once.

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
        prompt: `Analyze the given issue and its relationships to other open (non-Done, non-Cancelled) issues on the board.

## Steps

1. **Read the target issue** — use get_issue with the current issue's ID to get its full title and description
2. **List all open issues** — use list_issues filtered to statusName="Todo", "In Progress", and "In Review"
3. **Analyze relationships** for:
   - Sequential dependencies: does the target issue require another to be finished first?
   - Shared code areas: do both issues touch the same component, route, or service?
   - Merge conflict risk: are two issues In Progress simultaneously and modifying the same files?
   - Parent/child relationships: is one issue a sub-task or epic of the other?
4. **Add dependency links** using add_dependency:
   - issueId: the target issue's ID (the one being analyzed)
   - dependsOnId: the ID of the related issue
   - type: choose from depends_on, blocked_by, related_to, parent_of, child_of
5. **Update the issue description** with a "## Dependencies" section listing each relationship and its rationale

## Dependency type guide

- depends_on: target issue cannot start until the other is complete
- blocked_by: another issue is actively blocking the target
- related_to: same component/area, merge conflict risk, or thematically paired
- parent_of: target is an epic; the other is a sub-task
- child_of: target is a sub-task of the other issue

## Rules

- Only add a dependency if there is a clear technical reason the issues are coupled — avoid topical similarity alone
- Prefer related_to for In Progress issues that touch the same files (coordination risk)
- Prefer depends_on when one issue must land in production before the other can be implemented
- Skip issues that are already linked (check existing dependencies in get_issue output)
- Do not link an issue to itself`,
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
- Relevant files or areas (if inferable from the title/context)
- Open Questions (unresolved decisions, assumptions, or clarifications needed before work begins — use \`- [ ]\` checkboxes)`,
        model: "haiku",
      },
      {
        name: "orchestrator",
        description: "Delegating orchestrator — breaks work into sub-tasks and delegates to subagents or board tickets instead of doing everything itself",
        prompt: `You are a delegating orchestrator. Your job is to break the current task into discrete units of work and delegate every unit — do NOT implement anything yourself.

## Core Rules

1. **Never implement directly.** If code needs to be written, a test run, or a file edited, delegate it.
2. **No preliminary exploration.** Do not read files, search the codebase, or investigate architecture before delegating. Subagents will explore what they need.
3. **Minimal instructions.** Give each delegate just enough to act: what to do, which files/areas matter, and the acceptance criteria. No background essays.
4. **One task per delegate.** Each subagent or ticket handles one coherent unit of work.

## Process

### Step 1: Decompose

Read the current issue description. Break it into independent, actionable sub-tasks. Each sub-task should be completable without knowing the outcome of other sub-tasks (or explicitly state its dependency).

### Step 2: Delegate

For each sub-task, choose the delegation method:

**Use subagents (Agent tool) when:**
- The work is small enough to complete in one session
- The sub-task needs to produce code changes on the current branch
- You need the result before the next sub-task can proceed

Subagent prompt format:
\`\`\`
Task: <one sentence what to do>
Files: <specific paths if known, otherwise area of the codebase>
Acceptance: <how to verify it works>
\`\`\`

**Use board tickets (create_issue) when:**
- The work is large or independent enough for its own branch/workspace
- The sub-task can be picked up later by another agent session
- It represents a distinct deliverable

Ticket format:
- Title: imperative, actionable
- Description: what to implement + acceptance criteria, nothing else

### Step 3: Sequence

Launch independent subagents in parallel. Chain dependent ones sequentially. Use the Agent tool with run_in_background: true for parallel work.

### Step 4: Track

Update the parent issue description with:
- A checklist of sub-tasks and their status
- Links to any created tickets (by issue number)
- Blockers or failed delegations that need human attention

## Anti-patterns

- Do NOT read the codebase "to understand" before delegating. Delegate immediately.
- Do NOT write detailed technical specs for subagents. They can read code themselves.
- Do NOT do any implementation, even "quick fixes." Delegate it.
- Do NOT create tickets for trivial changes that a single subagent call can handle.`,
        model: null,
      },
      {
        name: "monitor-nudge",
        description: "Message sent to agents that have been running for more than 5 minutes without exiting — customize to change nudge behavior",
        prompt: `Please continue with the task. If you are waiting for input or unsure how to proceed, use your best judgment and keep moving forward. Check the issue description and any open questions, then take the next logical step.`,
        model: null,
      },
    ];

    const existingByName = new Map(
      (await db.select({ name: agentSkills.name }).from(agentSkills).where(eq(agentSkills.isBuiltin, true)))
        .map(r => [r.name, true])
    );

    let added = 0;
    for (const skill of DEFAULT_SKILLS) {
      if (existingByName.has(skill.name)) continue;
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
      added++;
    }
    if (added > 0) {
      console.log(`Seeded ${added} new default agent skill(s).`);
    } else {
      console.log("Agent skills already up to date.");
    }
  }

  // Upsert code-review-thorough skill (may not exist in older installs)
  const thoroughSkillName = "code-review-thorough";
  const existing = await db.select({ id: agentSkills.id }).from(agentSkills)
    .where(sql`${agentSkills.name} = ${thoroughSkillName} AND ${agentSkills.projectId} IS NULL`)
    .limit(1);
  if (existing.length === 0) {
    await db.insert(agentSkills).values({
      id: randomUUID(),
      name: thoroughSkillName,
      description: "In-depth AI code review using a more capable model — catches subtle bugs and architecture issues",
      prompt: `You are an expert AI code reviewer performing a thorough, in-depth review. Review the changes on branch '{{branch}}'.

First, run 'git diff --stat {{baseBranch}}' to see an overview of changed files.
Then review each file individually with 'git diff {{baseBranch}} -- <filepath>' — do NOT dump the entire diff at once.

Perform a deep analysis covering:
- Correctness bugs and edge cases
- Security vulnerabilities (injection, auth bypass, data exposure, etc.)
- Logic errors and off-by-one issues
- Missing error handling and exception safety
- Performance bottlenecks and unnecessary allocations
- Architectural concerns (coupling, SRP violations, testability)
- Missing tests for critical paths
- Naming, clarity, and maintainability

Classify each issue as CRITICAL (must fix — bugs, security, data loss), MAJOR (should fix — broken edge cases, poor error handling, performance), or MINOR (nice to have — style, naming, micro-optimizations).

{{autoFixInstructions}}

Do NOT move the issue to 'AI Reviewed' yourself — the system handles that on merge.

Issue ID: {{issueId}}
Workspace ID: {{workspaceId}}`,
      model: "claude-opus-4-7",
      isBuiltin: true,
      createdAt: now,
      updatedAt: now,
    });
    console.log("Seeded code-review-thorough skill.");
  }

  console.log('Run `pnpm cli -- register <path>` to register a git repo as a project.');
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
