import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { CLAUDE_MODEL_OPTIONS, CODEX_MODEL_OPTIONS, GLOBAL_BUTLER_PROJECT_ID, GLOBAL_BUTLER_PROJECT_NAME } from "@agentic-kanban/shared";
import { homedir } from "node:os";
import { streamSSE } from "hono/streaming";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
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
import { loadAgentSettings, isMockProfile } from "../services/agent-settings.service.js";
import type { ProviderName } from "../services/agent-provider.js";
import {
  parseStrategyBullseyeConfig,
  selectProviderFromStrategy,
  applyProviderSelectionToPrefMap,
} from "../services/strategy-objective.service.js";
import { resolveEffectiveProviderProfile } from "../services/effective-config.service.js";
import { getAllPreferences } from "../repositories/preferences.repository.js";
import { loadCodexLicenseRing, resolveCodexHomeForProfile } from "../services/codex-license-ring.js";

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

/** Per-project Claude profile override for the butler (empty = global claude_profile).
 *  Profile is auth/endpoint, shared by ALL of a project's butlers — not per-butler. */
function butlerProfilePrefKey(projectId: string): string {
  return `butler_profile_${projectId}`;
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
  function buildGlobalButlerPrompt(baseDir: string): string {
    const serverPort = process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001";
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
    const serverPort = process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001";
    const appPort = process.env.KANBAN_CLIENT_PORT || serverPort;
    const appBaseUrl = `http://localhost:${appPort}`;
    const boardGuidePath = ensureBoardGuideFile();
    return (prompt ?? DEFAULT_BUTLER_PROMPT)
      .replace(/\{\{projectName}}/g, projectName)
      .replace(/\{\{repoPath}}/g, repoPath)
      .replace(/\{\{serverPort}}/g, serverPort)
      .replace(/\{\{appBaseUrl}}/g, appBaseUrl)
      .replace(/\{\{boardGuidePath}}/g, boardGuidePath);
  }

  /** Resolve the Butler's backend/profile.
   *
   * Provider resolution funnels through the SHARED resolver
   * (`resolveEffectiveProviderProfile`) — the single source of truth used by the
   * workspace builder too. This route no longer hand-rolls its own
   * butler>Bullseye>settings cascade or hard-narrows to claude|codex, so copilot/pi
   * are first-class here as well. We layer the butler-specific overrides onto a
   * prefMap *copy* and let the resolver read a consistent view:
   *
   *  1. Per-butler provider override from the butler definition (`butlerProvider`) —
   *     written onto prefMap as `provider`.
   *  2. Project's Strategy Bullseye (`board_strategy_<projectId>`) — same source the
   *     workspace builder uses, mirrored onto prefMap via
   *     `applyProviderSelectionToPrefMap` (so the butler matches the builder).
   *  3. Global settings prefs (`provider` / `*_profile`) — the prefMap's own values,
   *     used by the resolver when neither override above is present.
   *
   * The per-project butler profile override (`butler_profile_<projectId>`) always wins
   * over the profile the resolver derives (it's an explicit user override for the
   * butler's auth endpoint, independent of which provider is primary).
   */
  async function resolveButlerBackend(projectId: string, butlerProvider?: ProviderName): Promise<{
    provider: ProviderName;
    selectedProfile: string | undefined;
    globalProfile: string;
    claudeProfile?: string;
    profile?: { provider: ProviderName; name: string };
    agentCommand?: string;
    agentArgs?: string;
    /** When a codex OAuth-license profile resolves to a separate CODEX_HOME dir,
     *  the launcher must set CODEX_HOME and drop `--profile` (mirrors the builder). */
    codexHome?: string;
  }> {
    const prefRows = await getAllPreferences(database);
    const prefMap = new Map(prefRows.map(r => [r.key, r.value]));

    const settings = await loadAgentSettings(database);
    const perProject = await getPreference(butlerProfilePrefKey(projectId), database);

    // Layer the butler-def override / Strategy Bullseye selection onto the prefMap so
    // the shared resolver reads a consistent view. Precedence: butler-def provider >
    // Bullseye selection > prefMap's own `provider`/`*_profile` (global settings).
    if (butlerProvider) {
      prefMap.set("provider", butlerProvider);
    } else {
      const strategyRaw = prefMap.get(`board_strategy_${projectId}`);
      if (strategyRaw) {
        try {
          // Single parser (arch-review §3.3): `parseStrategyBullseyeConfig` now
          // normalizes the blob through the SAME shared `normalizeProviderPolicies`
          // + `selectPolicyByPriority` the MCP `start_workspace` door
          // (`resolveProviderProfileFromPrefs`) uses, so the butler and MCP agree on
          // the provider for a given blob. Live-quota gating is deliberately NOT
          // applied here: this selects the provider for the ONE warm butler assistant
          // session (not a throughput of builder launches), so quota-headroom gating —
          // whose purpose is keeping fill/throttle BUILDER launches within a rate-limit
          // window — does not apply. The quota-aware door is the builder launch
          // (`resolveStrategyProviderSelection`).
          const strategyConfig = parseStrategyBullseyeConfig(strategyRaw);
          const selected = selectProviderFromStrategy(strategyConfig);
          if (selected) {
            applyProviderSelectionToPrefMap(prefMap, selected);
          }
        } catch {
          // non-fatal: fall through to global default already on prefMap
        }
      }
    }

    const { provider, profileName: resolverProfile } = resolveEffectiveProviderProfile(prefMap);

    const availableProfiles = await preferenceService.listProfilesForProvider(provider);
    const profileOverride = perProject && availableProfiles.includes(perProject) ? perProject : undefined;

    const globalProfile = settings.profile?.provider === provider ? settings.profile.name : "";
    // Per-project butler override > resolver-derived profile (Bullseye/global) > global profile.
    const selectedProfile = profileOverride || resolverProfile || globalProfile || undefined;

    // `settings.agentCommand`/`agentArgs` are derived under the GLOBAL provider
    // (e.g. Claude's `--dangerously-skip-permissions`). Forwarding them to a butler
    // whose per-butler provider differs from the global one injects the wrong
    // provider's command/flags — codex rejects `--dangerously-skip-permissions` and
    // exits with code 2. Only forward when the providers match; otherwise let the
    // butler's provider use its own defaults.
    const matchesGlobalProvider = provider === settings.provider;

    // Codex OAuth licenses: a ChatGPT-plan license is a separate CODEX_HOME directory
    // with its own auth.json (an auto-discovered `~/.codex-<name>` dir or a ring entry).
    // Point CODEX_HOME at it and DROP the profile name from the launch — a separate home
    // has no `[profiles.<name>]`, so `--profile` makes codex exit code 2. This mirrors the
    // builder path in session-lifecycle.ts so the butler authenticates under the right
    // account and its rollouts land in the right home (fixes 'no rollout found' resumes).
    let codexHome: string | undefined;
    let launchProfileName = selectedProfile;
    if (provider === "codex" && selectedProfile && selectedProfile !== "default") {
      try {
        const ring = await loadCodexLicenseRing(database);
        const resolved = resolveCodexHomeForProfile(selectedProfile, ring);
        if (resolved) {
          codexHome = resolved;
          launchProfileName = "default";
        }
      } catch {
        // non-fatal: fall back to passing --profile under the default home
      }
    }

    return {
      provider,
      // selectedProfile drives the UI dropdown — keep the real license name there.
      selectedProfile,
      globalProfile,
      claudeProfile: provider === "claude" ? selectedProfile : undefined,
      // profile drives the spawn args — "default" suppresses `--profile` when CODEX_HOME is set.
      profile: launchProfileName ? { provider, name: launchProfileName } : undefined,
      agentCommand: matchesGlobalProvider ? settings.agentCommand : undefined,
      agentArgs: matchesGlobalProvider ? settings.agentArgs : undefined,
      codexHome,
    };
  }

  async function startSession(projectId: string, butlerId: string = "default") {
    const project = await resolveProject(projectId);
    if (!project) return null;
    const def = await getButlerDefinition(database, butlerId);
    const backend = await resolveButlerBackend(projectId, def?.provider);
    const sdkBackend = butlerSdkBackend(backend.provider);
    // Model is a property of the (global) butler definition, not a per-project pref.
    const model = normalizeModelForBackend(def?.model, sdkBackend) || undefined;
    const resumeSessionId = (await getRuntimeState(butlerSessionStateKey(projectId, butlerId), database)) || undefined;
    const systemPromptAppend = projectId === GLOBAL_BUTLER_PROJECT_ID
      ? buildGlobalButlerPrompt(project.repoPath)
      : await resolveButlerPrompt(projectId, project.name, project.repoPath);
    const wasActive = getButlerSession(projectId, butlerId).active;
    // When the resolved profile is "mock", use the in-process mock backend instead
    // of the Claude SDK (which would fail without real API credentials).
    // NOTE: loadAgentSettings (used inside resolveButlerBackend) strips "mock" from
    // claudeProfile so it is never forwarded to spawn args. We must check the raw pref
    // directly — per-project butler override wins, then the global claude_profile.
    const rawProfile =
      (await getPreference(butlerProfilePrefKey(projectId), database)) ||
      (await getPreference("claude_profile", database)) ||
      undefined;
    const effectiveBackend: "claude" | "codex" | "mock" = isMockProfile(rawProfile)
      ? "mock"
      : sdkBackend;
    const session = ensureButlerSession({
      projectId,
      butlerId,
      repoPath: project.repoPath,
      projectName: project.name,
      backend: effectiveBackend,
      claudeProfile: backend.claudeProfile,
      profile: backend.profile,
      agentCommand: backend.agentCommand,
      agentArgs: backend.agentArgs,
      codexHome: backend.codexHome,
      model,
      resumeSessionId,
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
    const backend = await resolveButlerBackend(projectId, def?.provider);
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
    const def = await getButlerDefinition(database, butlerId);
    const backend = await resolveButlerBackend(projectId, def?.provider);
    const profiles = await preferenceService.listProfilesForProvider(backend.provider);
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
    const def = await getButlerDefinition(database, butlerId);
    const backend = await resolveButlerBackend(projectId, def?.provider);
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
