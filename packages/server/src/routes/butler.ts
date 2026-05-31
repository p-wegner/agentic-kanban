import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { projects, agentSkills } from "@agentic-kanban/shared/schema";
import { eq, sql, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { streamSSE } from "hono/streaming";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import { preferenceService } from "../services/preference.service.js";
import { scanLocalSkills } from "@agentic-kanban/shared/lib/agent-skill-files";
import { ensureBoardGuideFile } from "../butler/board-guide.js";
import {
  ensureButlerSession,
  sendButlerTurn,
  subscribeButler,
  stopButlerSession,
  getButlerSession,
  getButlerTranscript,
  getButlerCommands,
  setButlerModel,
  interruptButler,
  listProjectButlerStates,
} from "../services/butler-sdk.service.js";
import {
  listButlerDefinitions,
  getButlerDefinition,
  updateButlerDefinition,
} from "../services/butler-definitions.service.js";
import { listButlerSessions, getButlerSessionMessages } from "../services/butler-transcripts.service.js";
import { loadAgentSettings } from "../services/agent-settings.service.js";
import type { ProviderName } from "../services/agent-provider.js";

/** Suffix per-butler pref keys for named butlers; the "default" butler keeps the
 *  legacy unsuffixed keys so existing resume ids / history carry over unchanged. */
function butlerSuffix(butlerId: string): string {
  return butlerId && butlerId !== "default" ? `__${butlerId}` : "";
}

/** The butler selected by the `?butler=<id>` query param (defaults to "default"). */
function resolveButlerId(c: { req: { query: (k: string) => string | undefined } }): string {
  return c.req.query("butler")?.trim() || "default";
}

function butlerSessionPrefKey(projectId: string, butlerId: string): string {
  return `butler_session_${projectId}${butlerSuffix(butlerId)}`;
}

/** Rolling list of butler session IDs for this project+butler (JSON array, capped at 50). */
function butlerSessionHistoryPrefKey(projectId: string, butlerId: string): string {
  return `butler_session_history_${projectId}${butlerSuffix(butlerId)}`;
}

/** Append a sessionId to the per-project+butler session history preference. */
async function appendToSessionHistory(projectId: string, butlerId: string, sessionId: string, database: Database): Promise<void> {
  try {
    const key = butlerSessionHistoryPrefKey(projectId, butlerId);
    const raw = await getPreference(key, database);
    const ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    if (!ids.includes(sessionId)) {
      ids.unshift(sessionId); // most-recent first
      if (ids.length > 50) ids.length = 50;
      await setPreference(key, JSON.stringify(ids), database);
    }
  } catch (err) {
    console.warn(`[butler] failed to append session history: project=${projectId} butler=${butlerId}`, err);
  }
}

/** Per-project Claude profile override for the butler (empty = global claude_profile).
 *  Profile is auth/endpoint, shared by ALL of a project's butlers — not per-butler. */
function butlerProfilePrefKey(projectId: string): string {
  return `butler_profile_${projectId}`;
}

/** Fallback butler instructions, used when the editable `butler` agent skill is absent.
 *  Kept in sync with the `butler` entry in builtin-skills.ts / seed.ts. Supports the
 *  {{projectName}}, {{repoPath}}, {{serverPort}} placeholders. */
const DEFAULT_BUTLER_PROMPT = [
  `You are the project butler for "{{projectName}}" — a persistent, warm assistant embedded in the agentic-kanban board.`,
  ``,
  `Your role:`,
  `- Answer questions about the project, codebase, and active work`,
  `- Help with quick analysis, research, and code questions`,
  `- Give status overviews of the board and active agent sessions when asked`,
  `- Orchestrate work through the board and ensure the kanban workflow is followed`,
  ``,
  `For anything about the board (issues, statuses, counts, workspaces, sessions), use the "agentic-kanban" MCP tools (e.g. list_issues, get_board_status, get_issue) — they are authoritative. Do NOT guess board state or scrape it via curl.`,
  ``,
  `## Delegate aggressively to sub-agents`,
  `Use the Agent tool to spawn sub-agents for any task that requires code exploration, multi-file analysis, or research before acting. Your context window is precious — don't burn it reading dozens of files yourself when a sub-agent can do the exploration and return a concise summary.`,
  ``,
  `**Always delegate** when the user asks you to:`,
  `- Create tickets/issues that require understanding code first (e.g. "create tickets for improving error handling", "make a ticket to refactor the auth flow")`,
  `- Analyze a subsystem or area of the codebase`,
  `- Investigate bugs or find root causes across multiple files`,
  `- Compare implementations or find patterns across the codebase`,
  `- Do anything that would require reading more than 3–4 files`,
  ``,
  `**How to delegate ticket creation:**`,
  `Spawn a sub-agent with a clear prompt that includes the user's original request. The sub-agent explores the code, understands the scope, and uses the \`mcp__agentic-kanban__create_issue\` MCP tool to create the ticket with a well-informed title and description. Example sub-agent prompt:`,
  ``,
  `> "The user wants a ticket for improving error handling in the agent subsystem. Explore packages/server/src/services/agent*.ts and packages/shared/src/lib/ to understand the current error handling patterns. Then create a kanban ticket with a concrete description of what should change, referencing specific files and current patterns. Use mcp__agentic-kanban__create_issue."`,
  ``,
  `**Handle directly (no delegation needed):**`,
  `- Quick questions about board state, issue status, or project structure`,
  `- Simple ticket creation where no code exploration is needed (user already described exactly what they want)`,
  `- Starting/merging/reviewing workspaces`,
  `- UI how-to questions`,
  ``,
  `## Helping the user use the board`,
  "The user drives the board through the app's UI (clicking buttons and tabs), NOT the API. So when they ask \"how do I…\" / \"how does X work\" on the board, answer with SIMPLE UI steps — which tab or button to click — and keep it short; do not dump API calls, endpoints, or tool names at them. A UI how-to is bundled at `{{boardGuidePath}}`: READ it first and answer from it rather than from memory (button names are easy to get wrong). This is separate from you *doing* an action yourself — see \"Starting work\" below for that.",
  ``,
  `## Starting work on an issue`,
  `When asked to start, launch, or "work on" an issue, go through the board's one-step workspace flow so the FULL workflow runs — it creates the git worktree, moves the issue to In Progress, AND launches the agent in one step:`,
  ``,
  `  POST http://localhost:{{serverPort}}/api/workspaces`,
  `  body: { "issueId": "<the issue id>", "branch": "feature/ak-<issueNumber>-<short-kebab-slug>" }`,
  ``,
  `Resolve the issue's id, number, and title first with get_issue / list_issues. The 201 response contains the new workspace and a sessionId — that is your confirmation the agent actually launched.`,
  ``,
  `Do NOT, when starting work:`,
  "- use the start_workspace MCP tool — it only creates a worktree; it does NOT launch an agent or move the issue, so the workflow never runs",
  "- create worktrees or branches yourself (no `git worktree add`) or run `claude` directly",
  `- hand-move the issue to In Progress — launching does that for you`,
  ``,
  `Other board actions use dedicated tools/endpoints: move_issue (status changes), merge_workspace (merge), POST /api/workspaces/:id/turn (follow-up to a running agent), POST /api/workspaces/:id/review (review).`,
  ``,
  `## Verify — never fabricate`,
  `Never report that an action succeeded (agent launched, issue moved, branch created, merged) unless the board confirms it. After any state-changing action, re-check with get_issue / get_board_status and report the ACTUAL result. If a call failed or you are unsure, say so plainly — do not invent a success message.`,
  ``,
  `## Formatting`,
  `Your replies render as GitHub-flavored Markdown in a chat panel — use it to make answers scannable:`,
  `- Bold key terms, names, and values; use short ## / ### headings to structure any multi-part answer.`,
  `- Use bulleted or numbered lists for multiple points; keep each item tight.`,
  `- Use Markdown tables for structured/tabular data — issue lists, status counts, comparisons (e.g. columns # / Title / Status / Priority).`,
  `- Use inline code for identifiers, file paths, commands, and issue refs (e.g. #42); use fenced code blocks with a language for code or terminal output.`,
  `- Link with [text](url) when useful.`,
  `Match formatting to length: a one-line answer stays plain prose; anything longer gets headings, lists, or tables. Avoid dense walls of text.`,
  ``,
  `Project location: {{repoPath}}`,
  `Board API: http://localhost:{{serverPort}}/api`,
  ``,
  `Be helpful and well-organized; lead with the answer and avoid unnecessary preamble. You have full read access to the project files and standard tools.`,
].join("\n");

/**
 * Butler routes — a persistent, warm Claude assistant per project, backed by the
 * Claude Agent SDK (see butler-sdk.service.ts). Routes are mounted under /projects
 * so paths resolve as /:id/butler, /:id/butler/ensure, /:id/butler/message,
 * /:id/butler/stream.
 *
 * `getSessionManager` / `options` are accepted for signature compatibility with the
 * route factory but are not needed by the SDK-backed butler.
 */
export function createButlerRoute(
  database: Database,
  _getSessionManager: () => SessionManager,
  _options?: { boardEvents?: BoardEvents },
) {
  const router = createRouter();

  async function resolveProject(projectId: string) {
    const rows = await database.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    return rows[0] ?? null;
  }

  /** Resolve the butler's system prompt from the editable `butler` agent skill
   *  (project-scoped overrides global), falling back to DEFAULT_BUTLER_PROMPT, then
   *  substitute the {{projectName}}/{{repoPath}}/{{serverPort}} placeholders. */
  async function resolveButlerPrompt(projectId: string, projectName: string, repoPath: string): Promise<string> {
    const rows = await database
      .select({ prompt: agentSkills.prompt })
      .from(agentSkills)
      .where(sql`${agentSkills.name} = 'butler' AND (${agentSkills.projectId} = ${projectId} OR ${agentSkills.projectId} IS NULL)`)
      .orderBy(desc(agentSkills.projectId))
      .limit(1);
    const serverPort = process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001";
    const boardGuidePath = ensureBoardGuideFile();
    return (rows[0]?.prompt ?? DEFAULT_BUTLER_PROMPT)
      .replace(/\{\{projectName}}/g, projectName)
      .replace(/\{\{repoPath}}/g, repoPath)
      .replace(/\{\{serverPort}}/g, serverPort)
      .replace(/\{\{boardGuidePath}}/g, boardGuidePath);
  }

  /** Resolve the Butler's backend/profile from the global agent provider, with a per-project profile override. */
  async function resolveButlerBackend(projectId: string): Promise<{
    provider: Extract<ProviderName, "claude" | "codex">;
    selectedProfile: string | undefined;
    globalProfile: string;
    claudeProfile?: string;
    profile?: { provider: ProviderName; name: string };
    agentCommand?: string;
    agentArgs?: string;
  }> {
    const settings = await loadAgentSettings(database);
    const perProject = await getPreference(butlerProfilePrefKey(projectId), database);
    const provider = settings.provider === "codex" ? "codex" : "claude";
    const availableProfiles = provider === "codex" ? preferenceService.listCodexProfiles() : preferenceService.listClaudeProfiles();
    const profileOverride = perProject && availableProfiles.includes(perProject) ? perProject : undefined;
    const globalProfile = settings.profile?.provider === provider ? settings.profile.name : "";
    const selectedProfile = profileOverride || globalProfile || undefined;
    return {
      provider,
      selectedProfile,
      globalProfile,
      claudeProfile: provider === "claude" ? selectedProfile : undefined,
      profile: selectedProfile ? { provider, name: selectedProfile } : undefined,
      agentCommand: settings.agentCommand,
      agentArgs: settings.agentArgs,
    };
  }

  async function startSession(projectId: string, butlerId: string = "default") {
    const project = await resolveProject(projectId);
    if (!project) return null;
    const backend = await resolveButlerBackend(projectId);
    // Model is a property of the (global) butler definition, not a per-project pref.
    const model = (await getButlerDefinition(database, butlerId))?.model || undefined;
    const resumeSessionId = (await getPreference(butlerSessionPrefKey(projectId, butlerId), database)) || undefined;
    const systemPromptAppend = await resolveButlerPrompt(projectId, project.name, project.repoPath);
    const wasActive = getButlerSession(projectId, butlerId).active;
    const session = ensureButlerSession({
      projectId,
      butlerId,
      repoPath: project.repoPath,
      projectName: project.name,
      backend: backend.provider,
      claudeProfile: backend.claudeProfile,
      profile: backend.profile,
      agentCommand: backend.agentCommand,
      agentArgs: backend.agentArgs,
      model,
      resumeSessionId,
      systemPromptAppend,
    });
    // Persist the SDK session id (for resume across restarts) once, on first creation.
    if (!wasActive) {
      subscribeButler(projectId, (e) => {
        if (e.type === "session") {
          void setPreference(butlerSessionPrefKey(projectId, butlerId), e.sessionId, database);
          void appendToSessionHistory(projectId, butlerId, e.sessionId, database);
        }
      }, butlerId);
    }
    return session;
  }

  // GET /api/projects/:id/butlers — all defined butlers + this project's per-butler
  // runtime state (warm/cold, busy, context). Powers the butler switcher.
  router.get("/:id/butlers", async (c) => {
    const projectId = c.req.param("id");
    const defs = await listButlerDefinitions(database);
    const states = new Map(listProjectButlerStates(projectId).map((s) => [s.butlerId, s]));
    const butlers = defs.map((d) => {
      const st = states.get(d.id);
      return {
        id: d.id,
        name: d.name,
        model: d.model,
        active: !!st,
        busy: st?.busy ?? false,
        contextTokens: st?.contextTokens ?? 0,
        contextWindow: st?.contextWindow,
        sessionId: st?.sessionId ?? null,
        mcpConnected: st?.mcpConnected,
        backend: st?.backend ?? "claude",
      };
    });
    return c.json({ butlers });
  });

  // GET /api/projects/:id/butler — current butler state (for the selected ?butler=<id>)
  router.get("/:id/butler", async (c) => {
    const projectId = c.req.param("id");
    const butlerId = resolveButlerId(c);
    const state = getButlerSession(projectId, butlerId);
    const persisted = (await getPreference(butlerSessionPrefKey(projectId, butlerId), database)) || null;
    // Model is sourced from the butler definition (global), profile from the project pref.
    const selectedModel = (await getButlerDefinition(database, butlerId))?.model ?? "";
    const backend = await resolveButlerBackend(projectId);
    return c.json({
      butlerId,
      backend: backend.provider,
      active: state.active,
      sessionId: state.sessionId ?? persisted,
      contextTokens: state.contextTokens,
      model: state.model,
      contextWindow: state.contextWindow,
      mcpConnected: state.mcpConnected,
      // The user's saved picks (aliases/empty) — drive the dropdown selection.
      selectedModel,
      selectedProfile: backend.selectedProfile ?? "",
    });
  });

  // GET /api/projects/:id/butler/commands — slash commands for the input autocomplete.
  // Merges what the live SDK session reports with the repo's own .claude/skills/*/SKILL.md
  // (so repo skills are always suggested, even before the SDK finishes discovery or for
  // a project whose session isn't warm yet), deduped by name.
  router.get("/:id/butler/commands", async (c) => {
    const projectId = c.req.param("id");
    const butlerId = resolveButlerId(c);
    const byName = new Map<string, { name: string; description: string; argumentHint?: string }>();
    for (const cmd of getButlerCommands(projectId, butlerId)) {
      if (!byName.has(cmd.name)) byName.set(cmd.name, cmd);
    }
    const project = await resolveProject(projectId);
    if (project) {
      const diskSkills = await scanLocalSkills(project.repoPath);
      for (const skill of diskSkills) {
        const existing = byName.get(skill.name);
        // Add disk skills not yet known; backfill a description if the SDK entry lacked one.
        if (!existing) byName.set(skill.name, { name: skill.name, description: skill.description });
        else if (!existing.description && skill.description) existing.description = skill.description;
      }
    }
    const commands = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ commands });
  });

  // GET /api/projects/:id/butler/profiles — available Claude profiles + the butler's
  // current selection ("" = inherit the global claude_profile).
  router.get("/:id/butler/profiles", async (c) => {
    const projectId = c.req.param("id");
    const backend = await resolveButlerBackend(projectId);
    const profiles = backend.provider === "codex" ? preferenceService.listCodexProfiles() : preferenceService.listClaudeProfiles();
    return c.json({ provider: backend.provider, profiles, selected: backend.selectedProfile ?? "", globalDefault: backend.globalProfile });
  });

  // POST /api/projects/:id/butler/model — switch model for subsequent turns WITHOUT
  // restarting (preserves context, per the design). The model lives on the (global)
  // butler definition, so this updates the definition and applies it live to the
  // selected butler's warm session in this project.
  router.post("/:id/butler/model", async (c) => {
    const projectId = c.req.param("id");
    const butlerId = resolveButlerId(c);
    const body = await parseJsonBody<{ model?: string }>(c);
    const model = (body.model ?? "").trim();
    try {
      await updateButlerDefinition(database, butlerId, { model });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to update butler" }, 400);
    }
    // Apply live if a session is running; otherwise the model is picked up on next start.
    const applied = getButlerSession(projectId, butlerId).active ? await setButlerModel(projectId, model, butlerId) : false;
    return c.json({ ok: true, model, applied });
  });

  // POST /api/projects/:id/butler/profile — switch the Claude profile. A profile changes
  // auth/endpoint, which cannot change mid-session, so this RESTARTS the butler fresh
  // (forgets the resume id) per the design ("restart only where needed").
  router.post("/:id/butler/profile", async (c) => {
    const projectId = c.req.param("id");
    const butlerId = resolveButlerId(c);
    const body = await parseJsonBody<{ profile?: string }>(c);
    const profile = (body.profile ?? "").trim();
    await setPreference(butlerProfilePrefKey(projectId), profile, database);
    // Fresh session: stop, forget resume id (different endpoint can't resume), restart.
    stopButlerSession(projectId, butlerId);
    await setPreference(butlerSessionPrefKey(projectId, butlerId), "", database);
    const session = await startSession(projectId, butlerId);
    if (!session) return c.json({ error: "Project not found" }, 404);
    return c.json({ ok: true, profile, active: true });
  });

  // GET /api/projects/:id/butler/messages — conversation history for the active session,
  // so the chat UI can restore prior messages after a page reload.
  router.get("/:id/butler/messages", (c) => {
    return c.json({ messages: getButlerTranscript(c.req.param("id"), resolveButlerId(c)) });
  });

  // GET /api/projects/:id/butler/skill — the editable butler prompt + whether a
  // project-scoped override exists (vs the global default).
  router.get("/:id/butler/skill", async (c) => {
    const projectId = c.req.param("id");
    const override = await database.select({ prompt: agentSkills.prompt }).from(agentSkills)
      .where(sql`${agentSkills.name} = 'butler' AND ${agentSkills.projectId} = ${projectId}`).limit(1);
    if (override[0]) return c.json({ prompt: override[0].prompt, isOverride: true });
    const global = await database.select({ prompt: agentSkills.prompt }).from(agentSkills)
      .where(sql`${agentSkills.name} = 'butler' AND ${agentSkills.projectId} IS NULL`).limit(1);
    return c.json({ prompt: global[0]?.prompt ?? DEFAULT_BUTLER_PROMPT, isOverride: false });
  });

  // PUT /api/projects/:id/butler/skill — upsert the project-scoped butler override.
  // An empty prompt removes the override (revert to the global default).
  router.put("/:id/butler/skill", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody<{ prompt: string }>(c);
    const existing = await database.select({ id: agentSkills.id }).from(agentSkills)
      .where(sql`${agentSkills.name} = 'butler' AND ${agentSkills.projectId} = ${projectId}`).limit(1);
    const now = new Date().toISOString();
    if (!body.prompt?.trim()) {
      if (existing[0]) await database.delete(agentSkills).where(eq(agentSkills.id, existing[0].id));
      return c.json({ ok: true, isOverride: false });
    }
    if (existing[0]) {
      await database.update(agentSkills).set({ prompt: body.prompt, updatedAt: now }).where(eq(agentSkills.id, existing[0].id));
    } else {
      await database.insert(agentSkills).values({
        id: randomUUID(), name: "butler", projectId,
        description: "Project butler behavior override", prompt: body.prompt,
        isBuiltin: false, createdAt: now, updatedAt: now,
      });
    }
    return c.json({ ok: true, isOverride: true });
  });

  // POST /api/projects/:id/butler/ensure — start the warm session if not running
  router.post("/:id/butler/ensure", async (c) => {
    const projectId = c.req.param("id");
    const session = await startSession(projectId, resolveButlerId(c));
    if (!session) return c.json({ error: "Project not found" }, 404);
    return c.json({ active: true, sessionId: session.sessionId ?? null }, 201);
  });

  // POST /api/projects/:id/butler/interrupt — stop the in-flight turn (keeps the session warm)
  router.post("/:id/butler/interrupt", async (c) => {
    const ok = await interruptButler(c.req.param("id"), resolveButlerId(c));
    return c.json({ ok });
  });

  // POST /api/projects/:id/butler/message — send a turn to the warm session
  router.post("/:id/butler/message", async (c) => {
    const projectId = c.req.param("id");
    const butlerId = resolveButlerId(c);
    const body = await parseJsonBody<{ content: string }>(c);
    if (!body.content?.trim()) {
      return c.json({ error: "content is required" }, 400);
    }
    if (!getButlerSession(projectId, butlerId).active) {
      const session = await startSession(projectId, butlerId);
      if (!session) return c.json({ error: "Project not found" }, 404);
    }
    const ok = sendButlerTurn(projectId, body.content, { butlerId });
    if (!ok) return c.json({ error: "Butler is already processing a turn" }, 409);
    return c.json({ ok });
  });

  // POST /api/projects/:id/butler/ask — synchronous: send a turn, wait for the full
  // answer, and return it in one response. This is the primitive used by the CLI and
  // MCP tool (separate processes that cannot read the server's in-memory SSE stream).
  router.post("/:id/butler/ask", async (c) => {
    const projectId = c.req.param("id");
    const butlerId = resolveButlerId(c);
    const body = await parseJsonBody<{ content: string; timeoutMs?: number }>(c);
    if (!body.content?.trim()) {
      return c.json({ error: "content is required" }, 400);
    }
    if (!getButlerSession(projectId, butlerId).active) {
      const session = await startSession(projectId, butlerId);
      if (!session) return c.json({ error: "Project not found" }, 404);
    }
    if (getButlerSession(projectId, butlerId).busy) {
      return c.json({ error: "Butler is already processing a turn" }, 409);
    }
    const timeoutMs = typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : 120_000;
    const answer = await new Promise<{ text: string; isError: boolean }>((resolve) => {
      let buf = "";
      let settled = false;
      const finish = (text: string, isError: boolean) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        resolve({ text, isError });
      };
      const unsubscribe = subscribeButler(projectId, (e) => {
        if (e.type === "text") buf += e.text;
        else if (e.type === "result") finish(e.text ?? buf, e.isError ?? false);
        else if (e.type === "error") finish(e.message, true);
      }, butlerId);
      const timer = setTimeout(() => finish(buf || "(timed out waiting for butler response)", true), timeoutMs);
      // Emit the prompt to SSE listeners so the UI shows what was asked (CLI/MCP
      // callers have no UI that rendered it optimistically).
      if (!sendButlerTurn(projectId, body.content, { emitUserText: true, butlerId })) {
        finish("Butler is already processing a turn", true);
      }
    });
    return c.json({
      sessionId: getButlerSession(projectId, butlerId).sessionId ?? null,
      text: answer.text,
      isError: answer.isError,
    });
  });

  // GET /api/projects/:id/butler/stream — SSE stream of butler events
  router.get("/:id/butler/stream", (c) => {
    const projectId = c.req.param("id");
    const butlerId = resolveButlerId(c);
    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribeButler(projectId, (e) => {
        void stream.writeSSE({ data: JSON.stringify(e) });
      }, butlerId);
      stream.onAbort(() => unsubscribe());
      // Hold the connection open with periodic heartbeats until the client disconnects.
      while (!c.req.raw.signal.aborted) {
        await stream.sleep(15000);
        try {
          await stream.writeSSE({ event: "ping", data: "1" });
        } catch {
          break;
        }
      }
      unsubscribe();
    });
  });

  // GET /api/projects/:id/butler/sessions — list recent butler sessions from disk JSONL
  router.get("/:id/butler/sessions", async (c) => {
    const projectId = c.req.param("id");
    const butlerId = resolveButlerId(c);
    const limit = Math.min(parseInt(c.req.query("limit") ?? "5", 10) || 5, 20);
    const project = await resolveProject(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);

    const raw = await getPreference(butlerSessionHistoryPrefKey(projectId, butlerId), database);
    const allowedIds = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    if (allowedIds.size === 0) return c.json({ sessions: [] });

    const sessions = await listButlerSessions(project.repoPath, allowedIds, limit);
    return c.json({ sessions });
  });

  // GET /api/projects/:id/butler/sessions/:sid/messages — transcript of a past session
  router.get("/:id/butler/sessions/:sid/messages", async (c) => {
    const projectId = c.req.param("id");
    const butlerId = resolveButlerId(c);
    const sessionId = c.req.param("sid");
    const project = await resolveProject(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);

    // Security: only allow sessions that are tracked for this project
    const raw = await getPreference(butlerSessionHistoryPrefKey(projectId, butlerId), database);
    const allowedIds = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    if (!allowedIds.has(sessionId)) return c.json({ error: "Session not found" }, 404);

    const messages = await getButlerSessionMessages(project.repoPath, sessionId);
    return c.json({ messages });
  });

  // DELETE /api/projects/:id/butler — stop the warm session and forget the resume id.
  // Clearing the persisted session id means the NEXT ensure starts a fresh session,
  // which re-reads the (possibly customized) butler skill — so "stop butler" is how
  // users apply skill/behavior changes.
  router.delete("/:id/butler", async (c) => {
    const projectId = c.req.param("id");
    const butlerId = resolveButlerId(c);
    stopButlerSession(projectId, butlerId);
    await setPreference(butlerSessionPrefKey(projectId, butlerId), "", database);
    return c.json({ ok: true });
  });

  return router;
}
