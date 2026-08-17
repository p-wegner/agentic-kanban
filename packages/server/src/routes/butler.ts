import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import { listPluginRows } from "../repositories/plugins.repository.js";
import { parsePluginManifest } from "@agentic-kanban/shared/lib/plugin-manifest";
import type { Database } from "../db/index.js";
import { CLAUDE_MODEL_OPTIONS, CODEX_MODEL_OPTIONS, GLOBAL_BUTLER_PROJECT_ID, GLOBAL_BUTLER_PROJECT_NAME } from "@agentic-kanban/shared";
import { homedir } from "node:os";
import { streamSSE } from "hono/streaming";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { setPreference } from "../repositories/preferences.repository.js";
import { deleteRuntimeState, getRuntimeState, setRuntimeState } from "../repositories/runtime-state.repository.js";
import { getProjectById } from "../repositories/project.repository.js";
import { getProjectsBasePath } from "../repositories/project-service.repository.js";
import {
  getButlerPrompt,
  getButlerOverride,
  getGlobalButlerPrompt,
  upsertButlerOverride,
  deleteButlerOverride,
} from "../repositories/agent-skill.repository.js";
import { createPreferenceService } from "../services/preference.service.js";
import { scanLocalSkills } from "@agentic-kanban/shared/lib/agent-skill-files";
import { ensureBoardGuideFile } from "../butler/board-guide.js";
import { getPluginService } from "../services/plugin.service.js";
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
  answerButlerQuestion,
  type ButlerQuestionAnswer,
} from "../services/butler-sdk.service.js";
import {
  listButlerDefinitions,
  getButlerDefinition,
  updateButlerDefinition,
  resolveButlerLaunchConfig,
  butlerProfilePrefKey,
} from "../services/butler-definitions.service.js";
import { listButlerSessions, getButlerSessionMessages } from "../services/butler-transcripts.service.js";
import type { ProviderName } from "../services/agent-provider.js";
import { resolveBoardServerPort } from "@agentic-kanban/shared/lib/board-server-url";

/** Suffix per-butler pref keys for named butlers; the "default" butler keeps the
 *  legacy unsuffixed keys so existing resume ids / history carry over unchanged. */
function butlerSuffix(butlerId: string): string {
  return butlerId && butlerId !== "default" ? `__${butlerId}` : "";
}

/** The butler selected by the `?butler=<id>` query param (defaults to "default"). */
function resolveButlerId(c: { req: { query: (k: string) => string | undefined } }): string {
  return c.req.query("butler")?.trim() || "default";
}

// Butler session id + history are RUNTIME STATE (kept out of the `preferences`
// config table, #975) — persisted in `runtime_state` via the runtime-state repo.
function butlerSessionStateKey(projectId: string, butlerId: string): string {
  return `butler_session_${projectId}${butlerSuffix(butlerId)}`;
}

/** Rolling list of butler session IDs for this project+butler (JSON array, capped at 50). */
function butlerSessionHistoryStateKey(projectId: string, butlerId: string): string {
  return `butler_session_history_${projectId}${butlerSuffix(butlerId)}`;
}

/** Append a sessionId to the per-project+butler session history (runtime state). */
async function appendToSessionHistory(projectId: string, butlerId: string, sessionId: string, database: Database): Promise<void> {
  try {
    const key = butlerSessionHistoryStateKey(projectId, butlerId);
    const raw = await getRuntimeState(key, database);
    const ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    if (!ids.includes(sessionId)) {
      ids.unshift(sessionId); // most-recent first
      if (ids.length > 50) ids.length = 50;
      await setRuntimeState(key, JSON.stringify(ids), database);
    }
  } catch (err) {
    console.warn(`[butler] failed to append session history: project=${projectId} butler=${butlerId}`, err);
  }
}

/** The butler runs via the Claude Agent SDK (claude) or a CLI-spawn codex session.
 *  Copilot/pi resolve correctly through the shared resolver but are not yet wired as
 *  butler SDK backends, so they map onto the SDK default (claude) at launch. */
function butlerSdkBackend(provider: ProviderName): "claude" | "codex" {
  return provider === "codex" ? "codex" : "claude";
}

function normalizeModelForBackend(model: string | null | undefined, backend: "claude" | "codex" | "mock"): string {
  const value = model?.trim() ?? "";
  if (!value) return "";
  const options = backend === "codex" ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS;
  return options.some((option) => option.value === value) ? value : "";
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
  `For questions about how a previous ticket was implemented, what an agent did, or what problems it hit, use search_sessions to find matching transcript snippets, then get_session_transcript for the relevant session id when more detail is needed.`,
  ``,
  `For "how does X work?" or architecture/behavior questions about this project, first use openspec_list_specs and show_spec. Answer from the living spec when a relevant domain exists, and cite the spec path/domain in your answer. If no relevant living spec exists, say that and then inspect code or docs as needed.`,
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
  `## App links`,
  `When a direct link would help the user, link to the app at {{appBaseUrl}}. Key routes: Board {{appBaseUrl}}/board, Backlog {{appBaseUrl}}/backlog, Agents {{appBaseUrl}}/agents, Butler {{appBaseUrl}}/butler, Workflows {{appBaseUrl}}/workflows, Workflow analytics {{appBaseUrl}}/workflow-analytics, Table {{appBaseUrl}}/table, Graph {{appBaseUrl}}/graph, Timeline {{appBaseUrl}}/timeline, Metrics {{appBaseUrl}}/metrics, Quality metrics {{appBaseUrl}}/quality-metrics, Insights {{appBaseUrl}}/insights, Focus {{appBaseUrl}}/focus, Strategy {{appBaseUrl}}/strategy, Swimlane {{appBaseUrl}}/swimlane, Flaky tests {{appBaseUrl}}/flaky-tests, Monitor history {{appBaseUrl}}/monitor-history, Digest {{appBaseUrl}}/digest.`,
  `For example, after creating or discussing a workflow, include a concise link like [Open Workflows]({{appBaseUrl}}/workflows).`,
  ``,
  `Project location: {{repoPath}}`,
  `Board API: http://localhost:{{serverPort}}/api`,
  `Board app: {{appBaseUrl}}`,
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

  /** cwd for the global (project-less) butler: the projects base dir, else the home dir. */
  async function getGlobalButlerCwd(): Promise<string> {
    const rows = await getProjectsBasePath(database);
    return rows[0]?.value?.trim() || homedir();
  }

  /**
   * Resolve the project row for a butler request. For the reserved GLOBAL id there is no DB
   * row — return a synthetic project rooted at the projects base dir, so the butler is usable
   * with no project registered (e.g. to ask it to import/create one). All downstream code only
   * reads `.id`/`.name`/`.repoPath`, so the synthetic object is a full substitute.
   */
  async function resolveProject(projectId: string) {
    if (projectId === GLOBAL_BUTLER_PROJECT_ID) {
      return { id: GLOBAL_BUTLER_PROJECT_ID, name: GLOBAL_BUTLER_PROJECT_NAME, repoPath: await getGlobalButlerCwd() };
    }
    return getProjectById(projectId, database);
  }

  /** System prompt for the GLOBAL (project-less) butler. No project is registered/active,
   *  so its job is to help the user import or create their first project. */
  /**
   * What the board-level butler can say about PLUGINS (#390 gap 1).
   *
   * `getButlerFragments` is project-scoped by construction — it resolves `{{repoPath}}` and
   * friends against a real project — so the global butler could never use it, and was blind to
   * plugins entirely. What it actually needs is different anyway: not a plugin's project-specific
   * fragment, but the fact that a plugin EXISTS and can be enabled for the project it is about to
   * help create. Best-effort: a plugin listing must never keep the butler from starting.
   */
  async function describeInstalledPlugins(): Promise<string> {
    try {
      const rows = await listPluginRows(database);
      if (rows.length === 0) return "";
      const lines = rows.map((row) => {
        let summary = "";
        try {
          const manifest = parsePluginManifest(row.manifestJson);
          summary = manifest.description ? ` — ${manifest.description}` : "";
        } catch { /* a broken manifest still gets named */ }
        return `  - ${row.name} (id ${row.id}, slug ${row.pluginId})${summary}`;
      });
      return [
        "Installed plugins you can offer to enable once a project exists:",
        ...lines,
        "Use enable_plugin({ pluginId, projectId, location }) — enabling SCAFFOLDS the plugin, so pass"
        + " location: \"sidecar\" AT THAT POINT if its output belongs in a separate repo; setting it"
        + " afterwards leaves the scaffold in the wrong repo (#318). Then get_plugin_scaffold to read the"
        + " interview questions, ask the USER, and fill_plugin_scaffold to submit the answers.",
      ].join("\n");
    } catch (err) {
      console.warn("[butler] plugin listing failed (ignored):", err instanceof Error ? err.message : err);
      return "";
    }
  }

  function buildGlobalButlerPrompt(baseDir: string): string {
    const serverPort = String(resolveBoardServerPort());
    const boardGuidePath = ensureBoardGuideFile();
    return [
      `You are the agentic-kanban butler, running WITHOUT an active project — no project is registered or selected yet.`,
      `Your primary job right now is to help the user get their first project onto the board: IMPORT an existing git repository, or CREATE a new one.`,
      `Board API: http://localhost:${serverPort}/api`,
      `Use the "agentic-kanban" MCP tools: register_project (existing repo — pass its absolute repoPath), create_project (scaffold a new repo by name), or init_project. For a MULTI-REPO project, register/create the leading repo first, then add_project_repo({ projectId, path | cloneUrl | createName }) once per additional repo.`,
      `Default parent directory for new projects: ${baseDir}. If the user gives a name but no path, a folder is created under that base dir.`,
      `After you register/create a project, tell the user it is now on the board and to SELECT it (top-left project switcher) — selecting it makes it active and its own per-project butler takes over. You cannot start board work (issues/workspaces) until a project exists and is selected.`,
      `A UI how-to is bundled at ${boardGuidePath}; READ it for "how do I…" questions and answer with simple UI steps. Never claim an action succeeded unless a tool result confirms it; if unsure, say so.`,
      `Be concise and helpful. You have read access to the local filesystem and standard tools for inspecting a repo the user points you at before importing it.`,
    ].join("\n");
  }

  /** Resolve the butler's system prompt from the editable `butler` agent skill
   *  (project-scoped overrides global), falling back to DEFAULT_BUTLER_PROMPT, then
   *  substitute the {{projectName}}/{{repoPath}}/{{serverPort}} placeholders. */
  async function resolveButlerPrompt(projectId: string, projectName: string, repoPath: string): Promise<string> {
    const prompt = await getButlerPrompt(projectId, database);
    const serverPort = String(resolveBoardServerPort());
    const appPort = process.env.KANBAN_CLIENT_PORT || serverPort;
    const appBaseUrl = `http://localhost:${appPort}`;
    const boardGuidePath = ensureBoardGuideFile();
    const resolved = (prompt ?? DEFAULT_BUTLER_PROMPT)
      .replace(/\{\{projectName}}/g, projectName)
      .replace(/\{\{repoPath}}/g, repoPath)
      .replace(/\{\{serverPort}}/g, serverPort)
      .replace(/\{\{appBaseUrl}}/g, appBaseUrl)
      .replace(/\{\{boardGuidePath}}/g, boardGuidePath);
    // Append the butler prompt fragments of the plugins enabled for this project,
    // each as a clearly delimited "## Plugin: <name>" section. Best-effort: a
    // broken plugin must never keep the butler from starting.
    try {
      const fragments = await getPluginService(database).getButlerFragments(projectId);
      if (fragments.length > 0) return `${resolved}\n\n${fragments.join("\n\n")}`;
    } catch (err) {
      console.warn("[butler] plugin fragment resolution failed (ignored):", err instanceof Error ? err.message : err);
    }
    return resolved;
  }

  /** Resolve the Butler's backend/profile/model/resume — delegates to the shared
   *  `resolveButlerLaunchConfig` (butler-definitions.service.ts), the single source of
   *  truth for this route AND the headless warm-up paths (recommendation.ts,
   *  plugin-gate-butler.service.ts). */
  async function resolveButlerBackend(projectId: string, butlerId: string = "default") {
    return resolveButlerLaunchConfig(projectId, butlerId, database);
  }

  async function startSession(projectId: string, butlerId: string = "default") {
    const project = await resolveProject(projectId);
    if (!project) return null;
    const launch = await resolveButlerLaunchConfig(projectId, butlerId, database);
    const pluginNote = projectId === GLOBAL_BUTLER_PROJECT_ID ? await describeInstalledPlugins() : "";
    const systemPromptAppend = projectId === GLOBAL_BUTLER_PROJECT_ID
      ? [buildGlobalButlerPrompt(project.repoPath), pluginNote].filter(Boolean).join("\n\n")
      : await resolveButlerPrompt(projectId, project.name, project.repoPath);
    const wasActive = getButlerSession(projectId, butlerId).active;
    const session = ensureButlerSession({
      projectId,
      butlerId,
      repoPath: project.repoPath,
      projectName: project.name,
      backend: launch.backend,
      claudeProfile: launch.claudeProfile,
      profile: launch.profile,
      agentCommand: launch.agentCommand,
      agentArgs: launch.agentArgs,
      codexHome: launch.codexHome,
      model: launch.model,
      resumeSessionId: launch.resumeSessionId,
      systemPromptAppend,
    });
    // Persist the SDK session id (for resume across restarts) once, on first creation.
    if (!wasActive) {
      subscribeButler(projectId, (e) => {
        if (e.type === "session") {
          void setRuntimeState(butlerSessionStateKey(projectId, butlerId), e.sessionId, database);
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
    const globalBackend = await resolveButlerBackend(projectId);
    const butlers = defs.map((d) => {
      const st = states.get(d.id);
      // Prefer: active session's backend → per-butler provider → global provider
      const itemBackend = st?.backend ?? d.provider ?? butlerSdkBackend(globalBackend.provider);
      return {
        id: d.id,
        name: d.name,
        model: normalizeModelForBackend(d.model, itemBackend),
        active: !!st,
        busy: st?.busy ?? false,
        contextTokens: st?.contextTokens ?? 0,
        contextWindow: st?.contextWindow,
        sessionId: st?.sessionId ?? null,
        mcpConnected: st?.mcpConnected,
        backend: itemBackend,
        provider: d.provider ?? null,
      };
    });
    return c.json({ butlers });
  });

  // GET /api/projects/:id/butler — current butler state (for the selected ?butler=<id>)
  router.get("/:id/butler", async (c) => {
    const projectId = c.req.param("id");
    const butlerId = resolveButlerId(c);
    const state = getButlerSession(projectId, butlerId);
    const persisted = (await getRuntimeState(butlerSessionStateKey(projectId, butlerId), database)) || null;
    const def = await getButlerDefinition(database, butlerId);
    const backend = await resolveButlerBackend(projectId, butlerId);
    const effectiveBackend = state.active ? state.backend : butlerSdkBackend(backend.provider);
    // Model is sourced from the butler definition (global), profile from the project pref.
    const selectedModel = normalizeModelForBackend(def?.model, effectiveBackend);
    return c.json({
      butlerId,
      backend: effectiveBackend,
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

  // GET /api/projects/:id/butler/profiles — available profiles + the butler's
  // current selection ("" = inherit the global profile).
  router.get("/:id/butler/profiles", async (c) => {
    const projectId = c.req.param("id");
    const butlerId = resolveButlerId(c);
    const backend = await resolveButlerBackend(projectId, butlerId);
    // #604: build the service from the route's own `database` rather than reaching for the
    // module singleton. This was the one service wired BOTH ways — config-export-import
    // already did it this way, so the singleton's only consumer was here.
    const profiles = await createPreferenceService({ database }).listProfilesForProvider(backend.provider);
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
    const backend = await resolveButlerBackend(projectId, butlerId);
    const state = getButlerSession(projectId, butlerId);
    const model = normalizeModelForBackend(body.model, state.active ? state.backend : butlerSdkBackend(backend.provider));
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
    await deleteRuntimeState(butlerSessionStateKey(projectId, butlerId), database);
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
    const override = await getButlerOverride(projectId, database);
    if (override) return c.json({ prompt: override.prompt, isOverride: true });
    const global = await getGlobalButlerPrompt(database);
    return c.json({ prompt: global ?? DEFAULT_BUTLER_PROMPT, isOverride: false });
  });

  // PUT /api/projects/:id/butler/skill — upsert the project-scoped butler override.
  // An empty prompt removes the override (revert to the global default).
  router.put("/:id/butler/skill", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody<{ prompt: string }>(c);
    if (!body.prompt?.trim()) {
      await deleteButlerOverride(projectId, database);
      return c.json({ ok: true, isOverride: false });
    }
    await upsertButlerOverride(projectId, body.prompt, database);
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

  // POST /api/projects/:id/butler/answer — answer a parked AskUserQuestion (#460).
  // The butler's canUseTool handler suspended the SDK turn on this askId; resolving
  // it hands the model the user's choices and the turn continues.
  router.post("/:id/butler/answer", async (c) => {
    const projectId = c.req.param("id");
    const butlerId = resolveButlerId(c);
    const body = await parseJsonBody<{ askId?: string; answers?: ButlerQuestionAnswer[] }>(c);
    const askId = body.askId?.trim();
    if (!askId) return c.json({ error: "askId is required" }, 400);
    if (!Array.isArray(body.answers) || body.answers.length === 0) {
      return c.json({ error: "answers is required" }, 400);
    }
    const answers: ButlerQuestionAnswer[] = body.answers
      .filter((a) => typeof a?.question === "string" && Array.isArray(a?.answers))
      .map((a) => ({
        question: a.question,
        header: typeof a.header === "string" && a.header ? a.header : a.question.slice(0, 12),
        answers: a.answers.filter((x): x is string => typeof x === "string" && x.trim().length > 0),
      }))
      .filter((a) => a.answers.length > 0);
    if (answers.length === 0) return c.json({ error: "answers is required" }, 400);
    const ok = answerButlerQuestion(projectId, askId, answers, butlerId);
    // 409, not 404: the question existed but is no longer answerable (timed out,
    // already answered, or the session was restarted).
    if (!ok) return c.json({ error: "No question is waiting for this answer", ok: false }, 409);
    return c.json({ ok: true });
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
      // The ONE interactive subscriber: a human has the Butler chat open, so a parked
      // AskUserQuestion can actually be answered here (#461). Every other subscriber
      // (the /ask collector, the session-id persister) is deliberately not.
      const unsubscribe = subscribeButler(projectId, (e) => {
        void stream.writeSSE({ data: JSON.stringify(e) });
      }, butlerId, { interactive: true });
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

    const raw = await getRuntimeState(butlerSessionHistoryStateKey(projectId, butlerId), database);
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
    const raw = await getRuntimeState(butlerSessionHistoryStateKey(projectId, butlerId), database);
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
    await deleteRuntimeState(butlerSessionStateKey(projectId, butlerId), database);
    return c.json({ ok: true });
  });

  return router;
}
