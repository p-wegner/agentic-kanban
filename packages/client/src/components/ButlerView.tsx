import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, apiPost, apiPut, apiDelete } from "../lib/api.js";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import type { LiveSessionStats } from "../lib/useBoardEvents.js";
import { type ButlerVoiceButtonHandle } from "./ButlerVoiceButton.js";
import {
  reduceButlerEvent,
  type ButlerEvent,
  type AssistantBuf,
  type ButlerChatMessage as ChatMessage,
} from "../lib/butler-event-reducer.js";
import type { ButlerState, ButlerCommand, ButlerSessionSummary, ButlerSessionMessage, ButlerListItem, TabState } from "../lib/butler-types.js";
import { formatWindow, formatRelativeTs, backendLabel, modelOptionsForBackend } from "../lib/butler-format.js";
import { buildButlerUrl } from "../lib/butler-url.js";
import { parseSlashCommand, filterCommands, applyCommandToInput, nextCycleIndex } from "../lib/butler-slash-commands.js";
import { sanitizeSpeechText } from "../lib/butler-speech.js";
import { type ButlerDef } from "./ButlerManageModal.js";
import { ButlerViewBody } from "./ButlerViewBody.js";

interface ButlerViewProps {
  projectId: string;
  columns: StatusWithIssues[];
  liveActivity: Record<string, string>;
  liveStats: Record<string, LiveSessionStats>;
  onIssueClick: (issue: IssueWithStatus) => void;
  onExit?: () => void;
  /**
   * A message to pre-fill into the active butler tab's input once it's ready
   * (e.g. the "Chat about this ticket" entry point from a ticket — #838). Each
   * distinct value is applied once; the butler is started first if it's cold so
   * the prompt can be sent. Consumed via {@link ButlerViewProps.onInitialPromptConsumed}.
   */
  initialPrompt?: string;
  /** Called after `initialPrompt` has been prefilled, so the parent can clear it. */
  onInitialPromptConsumed?: () => void;
}

function makeTabState(butlerId: string, butlerName: string): TabState {
  return {
    butlerId,
    butlerName,
    chatMessages: [],
    butlerState: null,
    backend: "claude",
    contextTokens: 0,
    model: undefined,
    contextWindow: undefined,
    mcpConnected: undefined,
    selectedModel: "",
    sending: false,
    input: "",
    profiles: [],
    selectedProfile: "",
    globalProfile: "",
    commands: [],
    historyOpen: false,
    historySessions: [],
    historyLoading: false,
    historyTranscript: null,
    customizeOpen: false,
    customizePrompt: "",
    customizeBusy: false,
  };
}

// ─── Inline tab rename ───────────────────────────────────────────────────────

// ─── Main ButlerView ─────────────────────────────────────────────────────────

export function ButlerView({ projectId, columns, liveActivity, liveStats, onIssueClick, onExit, initialPrompt, onInitialPromptConsumed }: ButlerViewProps) {
  const [loadingState, setLoadingState] = useState(true);
  const [butlers, setButlers] = useState<ButlerListItem[]>([]);
  const [butlerMax, setButlerMax] = useState(4);
  const [manageOpen, setManageOpen] = useState(false);

  // Tabs: list of open tab ids (ordered) + the active one.
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("");
  // Per-tab mutable state keyed by butlerId.
  const [tabStates, setTabStates] = useState<Record<string, TabState>>({});
  // Rename: which tab is being edited inline.
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  // Add-tab dropdown: click-controlled (a hover-only menu had a dead-zone gap
  // between the "+" button and the menu, so the click never landed — #842).
  const [addTabOpen, setAddTabOpen] = useState(false);
  const addTabRef = useRef<HTMLDivElement>(null);

  // Per-tab SSE streams: kept outside React state to avoid re-render churn.
  const eventSourcesRef = useRef<Record<string, EventSource>>({});
  // Per-tab streaming buffer state (outside React state for the same reason).
  const assistantBufsRef = useRef<Record<string, AssistantBuf>>({});
  // Per-tab input value refs (mirrors tab.input for closure access).
  const inputValuesRef = useRef<Record<string, string>>({});

  // Voice/dictation state — shared, applies to the active tab.
  const [interimVoiceText, setInterimVoiceText] = useState("");
  const [isDictating, setIsDictating] = useState(false);
  const voiceButtonRef = useRef<ButlerVoiceButtonHandle>(null);
  const hasDictatedRef = useRef(false);
  const voiceInterimRef = useRef("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const modelSelectRef = useRef<HTMLSelectElement>(null);
  const profileSelectRef = useRef<HTMLSelectElement>(null);
  const commandIndexRef = useRef(0);
  const [commandIndex, setCommandIndex] = useState(0);

  // Derived active tab state.
  const tab = tabStates[activeTabId];
  const activeModelOptions = modelOptionsForBackend(tab?.backend);

  // ── Helpers ──

  function butlerUrl(butlerId: string, path: string): string {
    return buildButlerUrl(projectId, butlerId, path);
  }

  function getOrInitBuf(butlerId: string) {
    if (!assistantBufsRef.current[butlerId]) {
      assistantBufsRef.current[butlerId] = { buf: "", msgId: null, textSeen: false };
    }
    return assistantBufsRef.current[butlerId];
  }

  const updateTab = useCallback((butlerId: string, patch: Partial<TabState>) => {
    setTabStates((prev) => {
      const cur = prev[butlerId];
      if (!cur) return prev;
      return { ...prev, [butlerId]: { ...cur, ...patch } };
    });
  }, []);

  // Apply one SSE event via the pure reducer (lib/butler-event-reducer.ts). The
  // per-tab assistant-text buffer stays in a ref; we capture it before the state
  // update and write back the reducer's new buffer. No StrictMode here, and the
  // captured prevBuf keeps the write idempotent regardless.
  function handleButlerEvent(butlerId: string, e: ButlerEvent) {
    const prevBuf = getOrInitBuf(butlerId);
    setTabStates((prev) => {
      const cur = prev[butlerId];
      if (!cur) return prev;
      const { state: next, buf: nextBuf } = reduceButlerEvent(cur, prevBuf, e, {
        now: () => Date.now(),
        rand: () => String(Math.random()),
      });
      assistantBufsRef.current[butlerId] = nextBuf;
      return { ...prev, [butlerId]: next };
    });
  }

  function openStream(butlerId: string) {
    eventSourcesRef.current[butlerId]?.close();
    const es = new EventSource(butlerUrl(butlerId, "/stream"));
    es.onmessage = (ev) => {
      try {
        handleButlerEvent(butlerId, JSON.parse(ev.data as string) as ButlerEvent);
      } catch { /* ignore non-JSON heartbeats */ }
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
    eventSourcesRef.current[butlerId] = es;
  }

  function closeStream(butlerId: string) {
    eventSourcesRef.current[butlerId]?.close();
    delete eventSourcesRef.current[butlerId];
  }

  async function fetchButlers() {
    try {
      const [r, defs] = await Promise.all([
        apiFetch<{ butlers: ButlerListItem[] }>(`/api/projects/${projectId}/butlers`),
        apiFetch<{ butlers: ButlerDef[]; max: number }>("/api/butler-definitions"),
      ]);
      setButlers(r.butlers);
      setButlerMax(defs.max);
      // Sync butlerName for open tabs from fresh list
      setTabStates((prev) => {
        const next = { ...prev };
        for (const b of r.butlers) {
          if (next[b.id]) {
            next[b.id] = { ...next[b.id], butlerName: b.name };
          }
        }
        return next;
      });
      return r.butlers;
    } catch {
      return [] as ButlerListItem[];
    }
  }

  async function loadCapabilities(butlerId: string) {
    try {
      const [cmdData, profData] = await Promise.all([
        apiFetch<{ commands: ButlerCommand[] }>(butlerUrl(butlerId, "/commands")),
        // Must scope to THIS butler — an unscoped /profiles returns the default butler's
        // provider and would clobber a codex tab's backend back to claude (#829).
        apiFetch<{ provider?: "claude" | "codex"; profiles: string[]; selected: string; globalDefault: string }>(butlerUrl(butlerId, "/profiles")),
      ]);
      updateTab(butlerId, {
        commands: cmdData.commands,
        backend: profData.provider ?? "claude",
        profiles: profData.profiles,
        selectedProfile: profData.selected,
        globalProfile: profData.globalDefault,
      });
    } catch { /* capabilities are best-effort */ }
  }

  async function loadTabButler(butlerId: string) {
    const buf = getOrInitBuf(butlerId);
    buf.buf = "";
    buf.msgId = null;
    buf.textSeen = false;
    closeStream(butlerId);
    setTabStates((prev) => {
      const cur = prev[butlerId];
      if (!cur) return prev;
      return {
        ...prev,
        [butlerId]: {
          ...cur,
          chatMessages: [],
          butlerState: null,
          contextTokens: 0,
          model: undefined,
          contextWindow: undefined,
          mcpConnected: undefined,
          sending: false,
        },
      };
    });
    try {
      const state = await apiFetch<ButlerState>(butlerUrl(butlerId, ""));
      updateTab(butlerId, {
        butlerState: state,
        backend: state.backend ?? "claude",
        contextTokens: state.contextTokens ?? 0,
        model: state.model,
        contextWindow: state.contextWindow,
        mcpConnected: state.mcpConnected,
        selectedModel: state.selectedModel ?? "",
      });
      if (state.active) {
        try {
          const { messages } = await apiFetch<{ messages: { role: "user" | "assistant"; text: string; ts: number }[] }>(butlerUrl(butlerId, "/messages"));
          if (messages.length) {
            setTabStates((prev) => {
              const cur = prev[butlerId];
              if (!cur) return prev;
              return {
                ...prev,
                [butlerId]: {
                  ...cur,
                  chatMessages: messages.map((m, i) => ({ id: `hist-${i}-${m.ts}`, role: m.role, text: m.text, ts: m.ts })),
                },
              };
            });
          }
        } catch { /* no history */ }
        openStream(butlerId);
      }
      // Always load provider-aware capabilities (backend, profiles, slash commands) so a
      // focused tab shows the correct provider's label/model/profile options even when the
      // butler is cold. Previously gated on state.active, which left a codex butler tab
      // stuck on the Claude label + Claude dropdowns until it was started (#829).
      void loadCapabilities(butlerId);
    } catch {
      updateTab(butlerId, { butlerState: { active: false, sessionId: null } });
    }
  }

  // ── Tab management ──

  function openTab(butlerId: string, butlerName: string) {
    setTabStates((prev) => {
      if (prev[butlerId]) return prev;
      return { ...prev, [butlerId]: makeTabState(butlerId, butlerName) };
    });
    setOpenTabs((prev) => {
      if (prev.includes(butlerId)) return prev;
      return [...prev, butlerId];
    });
    setActiveTabId(butlerId);
  }

  function closeTab(butlerId: string) {
    closeStream(butlerId);
    setOpenTabs((prev) => {
      const next = prev.filter((id) => id !== butlerId);
      // Move active tab to nearest neighbour
      setActiveTabId((cur) => {
        if (cur !== butlerId) return cur;
        const idx = prev.indexOf(butlerId);
        return next[Math.max(0, idx - 1)] ?? next[0] ?? "";
      });
      return next;
    });
    setTabStates((prev) => {
      const next = { ...prev };
      delete next[butlerId];
      return next;
    });
    delete assistantBufsRef.current[butlerId];
    delete inputValuesRef.current[butlerId];
  }

  async function renameButler(butlerId: string, newName: string) {
    try {
      await apiPut(`/api/butler-definitions/${butlerId}`, { name: newName });
      updateTab(butlerId, { butlerName: newName });
      setButlers((prev) => prev.map((b) => b.id === butlerId ? { ...b, name: newName } : b));
    } catch (err) {
      console.error("Failed to rename butler", err);
    }
  }

  // ── Mount / project change ──

  useEffect(() => {
    setLoadingState(true);
    // Close all existing streams
    for (const id of Object.keys(eventSourcesRef.current)) {
      closeStream(id);
    }
    setOpenTabs([]);
    setActiveTabId("");
    setTabStates({});
    assistantBufsRef.current = {};
    inputValuesRef.current = {};
    setRenamingTabId(null);
    setManageOpen(false);

    void (async () => {
      const list = await fetchButlers();
      // Restore saved open tabs from localStorage, falling back to the first butler.
      let savedTabs: string[] = [];
      try {
        const raw = localStorage.getItem(`butler:tabs:${projectId}`);
        if (raw) savedTabs = JSON.parse(raw) as string[];
      } catch { /* ignore */ }
      const validIds = list.map((b) => b.id);
      const restoredTabs = savedTabs.filter((id) => validIds.includes(id));
      const initialTabs = restoredTabs.length > 0 ? restoredTabs : [list[0]?.id ?? "default"].filter(Boolean);

      // Build initial tab states
      const initialStates: Record<string, TabState> = {};
      for (const id of initialTabs) {
        const butler = list.find((b) => b.id === id);
        initialStates[id] = makeTabState(id, butler?.name ?? id);
      }
      setTabStates(initialStates);
      setOpenTabs(initialTabs);

      let savedActive = "";
      try { savedActive = localStorage.getItem(`butler:active:${projectId}`) || ""; } catch { /* ignore */ }
      const activeId = initialTabs.includes(savedActive) ? savedActive : initialTabs[0] ?? "";
      setActiveTabId(activeId);

      // Load each tab's butler state (prioritise active tab first)
      const toLoad = activeId ? [activeId, ...initialTabs.filter((id) => id !== activeId)] : initialTabs;
      for (const id of toLoad) {
        await loadTabButler(id);
      }
      setLoadingState(false);
    })();

    return () => {
      for (const id of Object.keys(eventSourcesRef.current)) {
        closeStream(id);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Persist open tabs when they change.
  useEffect(() => {
    if (openTabs.length === 0) return;
    try { localStorage.setItem(`butler:tabs:${projectId}`, JSON.stringify(openTabs)); } catch { /* ignore */ }
  }, [openTabs, projectId]);

  // Persist active tab.
  useEffect(() => {
    if (!activeTabId) return;
    try { localStorage.setItem(`butler:active:${projectId}`, activeTabId); } catch { /* ignore */ }
    // Load tab data if it hasn't been loaded yet.
    if (activeTabId && tabStates[activeTabId] && tabStates[activeTabId].butlerState === null && !loadingState) {
      void loadTabButler(activeTabId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  // Auto-scroll active tab on new messages.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [tab?.chatMessages]);

  // Close the add-tab dropdown on outside click / Escape (#842).
  useEffect(() => {
    if (!addTabOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (addTabRef.current && !addTabRef.current.contains(e.target as Node)) setAddTabOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") setAddTabOpen(false); };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [addTabOpen]);

  // Prefill the active tab with an external prompt (e.g. "Chat about this ticket",
  // #838). Apply each distinct prompt once: start the butler if it's cold, drop the
  // text into the input for review, focus + size the textarea, and notify the parent
  // so it can clear the prompt. We deliberately do NOT auto-send — the user gets to
  // see the ticket context that was injected and tweak it before the first turn.
  const appliedInitialPromptRef = useRef<string | null>(null);
  useEffect(() => {
    if (loadingState || !initialPrompt || !activeTabId) return;
    if (appliedInitialPromptRef.current === initialPrompt) return;
    const cur = tabStates[activeTabId];
    if (!cur) return;
    appliedInitialPromptRef.current = initialPrompt;
    void (async () => {
      if (!cur.butlerState?.active) {
        await handleStart();
      }
      setTabInput(activeTabId, initialPrompt);
      requestAnimationFrame(() => {
        const t = inputRef.current;
        if (t) {
          t.focus();
          t.style.height = "auto";
          t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
        }
      });
      onInitialPromptConsumed?.();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt, loadingState, activeTabId]);

  // ── Per-tab actions ──

  async function handleStart() {
    if (!tab) return;
    updateTab(activeTabId, { sending: true });
    try {
      const result = await apiFetch<ButlerState>(butlerUrl(activeTabId, "/ensure"), { method: "POST", body: "{}" });
      updateTab(activeTabId, { butlerState: { active: true, sessionId: result.sessionId }, sending: false });
      openStream(activeTabId);
      void loadCapabilities(activeTabId);
      void fetchButlers();
    } catch (err) {
      console.error("Failed to start butler", err);
      updateTab(activeTabId, { sending: false });
    }
  }

  async function handleClearContext() {
    if (!tab || tab.sending) return;
    closeStream(activeTabId);
    const buf = getOrInitBuf(activeTabId);
    buf.buf = "";
    buf.msgId = null;
    buf.textSeen = false;
    try {
      await apiDelete(butlerUrl(activeTabId, ""));
    } catch { /* ignore */ }
    updateTab(activeTabId, {
      chatMessages: [],
      contextTokens: 0,
      butlerState: { active: true, sessionId: null },
    });
    openStream(activeTabId);
    void fetchButlers();
  }

  async function handleNewSession() {
    await handleClearContext();
    inputRef.current?.focus();
  }

  async function handleModelChange(value: string) {
    if (!tab) return;
    updateTab(activeTabId, { selectedModel: value });
    try {
      await apiPost(butlerUrl(activeTabId, "/model"), { model: value });
      void fetchButlers();
    } catch (err) {
      console.error("Failed to switch butler model", err);
    }
  }

  function cycleModel() {
    if (!tab || tab.sending || activeModelOptions.length === 0) return;
    const current = tab.selectedModel || tab.model || activeModelOptions[0]?.value;
    const currentIndex = activeModelOptions.findIndex((item) => item.value === current);
    const next = activeModelOptions[nextCycleIndex(activeModelOptions.length, currentIndex)];
    if (next) {
      void handleModelChange(next.value);
      modelSelectRef.current?.focus();
    }
  }

  async function handleProfileChange(value: string) {
    if (!tab || tab.sending) return;
    updateTab(activeTabId, { selectedProfile: value, sending: true });
    closeStream(activeTabId);
    try {
      await apiPost(butlerUrl(activeTabId, "/profile"), { profile: value });
      const buf = getOrInitBuf(activeTabId);
      buf.buf = "";
      buf.msgId = null;
      buf.textSeen = false;
      updateTab(activeTabId, {
        chatMessages: [],
        contextTokens: 0,
        model: undefined,
        butlerState: { active: true, sessionId: null },
        sending: false,
      });
      openStream(activeTabId);
      void loadCapabilities(activeTabId);
    } catch (err) {
      console.error("Failed to switch butler profile", err);
      updateTab(activeTabId, { sending: false });
    }
  }

  function cycleProfile() {
    if (!tab) return;
    const options = ["", ...tab.profiles];
    if (tab.sending || options.length === 0) return;
    if (options.length === 1) { profileSelectRef.current?.focus(); return; }
    const currentIndex = options.indexOf(tab.selectedProfile);
    const next = options[nextCycleIndex(options.length, currentIndex)];
    void handleProfileChange(next);
  }

  function setTabInput(butlerId: string, value: string) {
    inputValuesRef.current[butlerId] = value;
    updateTab(butlerId, { input: value });
  }

  function appendVoiceTranscript(chunk: string) {
    const safeChunk = sanitizeSpeechText(chunk);
    if (!safeChunk) return;
    hasDictatedRef.current = true;
    const prev = inputValuesRef.current[activeTabId] ?? "";
    const sep = prev.length > 0 && !/\s$/.test(prev) ? " " : "";
    setTabInput(activeTabId, prev + sep + safeChunk);
    requestAnimationFrame(() => {
      const t = inputRef.current;
      if (t) {
        t.style.height = "auto";
        t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
      }
    });
  }

  async function handleSend(explicitContent?: string) {
    if (!tab) return;
    const content = (explicitContent ?? inputValuesRef.current[activeTabId] ?? "").trim();
    if (!content || tab.sending || !tab.butlerState?.active) return;

    const userMsg: ChatMessage = { id: `user-${Date.now()}`, role: "user", text: content, ts: Date.now() };
    setTabStates((prev) => {
      const cur = prev[activeTabId];
      if (!cur) return prev;
      return { ...prev, [activeTabId]: { ...cur, chatMessages: [...cur.chatMessages, userMsg], input: "", sending: true } };
    });
    inputValuesRef.current[activeTabId] = "";
    hasDictatedRef.current = false;
    const buf = getOrInitBuf(activeTabId);
    buf.buf = "";
    buf.msgId = null;
    buf.textSeen = false;

    try {
      await apiPost<{ ok: boolean }>(butlerUrl(activeTabId, "/message"), { content });
    } catch (err) {
      setTabStates((prev) => {
        const cur = prev[activeTabId];
        if (!cur) return prev;
        return {
          ...prev,
          [activeTabId]: {
            ...cur,
            chatMessages: [...cur.chatMessages, {
              id: `err-${Date.now()}`,
              role: "activity",
              text: `Error: ${err instanceof Error ? err.message : "Failed to send message"}`,
              ts: Date.now(),
            }],
            sending: false,
          },
        };
      });
    }
  }

  async function handleStop() {
    if (!tab || !tab.sending) return;
    try {
      await apiFetch(butlerUrl(activeTabId, "/interrupt"), { method: "POST", body: "{}" });
    } catch (err) {
      console.error("Failed to stop butler", err);
    }
    updateTab(activeTabId, { sending: false });
  }

  // ── History + Customize ──

  async function openHistory() {
    if (!tab) return;
    const next = !tab.historyOpen;
    updateTab(activeTabId, { historyOpen: next, historyTranscript: null });
    if (next) {
      updateTab(activeTabId, { historyLoading: true });
      try {
        const r = await apiFetch<{ sessions: ButlerSessionSummary[] }>(butlerUrl(activeTabId, "/sessions?limit=5"));
        updateTab(activeTabId, { historySessions: r.sessions, historyLoading: false });
      } catch {
        updateTab(activeTabId, { historySessions: [], historyLoading: false });
      }
    }
  }

  async function openHistoryTranscript(session: ButlerSessionSummary) {
    if (!tab) return;
    updateTab(activeTabId, { historyTranscript: { session, messages: [] } });
    try {
      const r = await apiFetch<{ messages: ButlerSessionMessage[] }>(butlerUrl(activeTabId, `/sessions/${session.sessionId}/messages`));
      updateTab(activeTabId, { historyTranscript: { session, messages: r.messages } });
    } catch { /* keep empty */ }
  }

  async function openCustomize() {
    if (!tab) return;
    updateTab(activeTabId, { customizeOpen: true, customizeBusy: true });
    try {
      const r = await apiFetch<{ prompt: string; isOverride: boolean }>(`/api/projects/${projectId}/butler/skill`);
      updateTab(activeTabId, { customizePrompt: r.prompt, customizeBusy: false });
    } catch {
      updateTab(activeTabId, { customizePrompt: "", customizeBusy: false });
    }
  }

  async function saveCustomize() {
    if (!tab) return;
    updateTab(activeTabId, { customizeBusy: true });
    try {
      await apiPut(`/api/projects/${projectId}/butler/skill`, { prompt: tab.customizePrompt });
      updateTab(activeTabId, { customizeOpen: false, customizeBusy: false });
      await handleClearContext();
    } catch (err) {
      console.error("Failed to save butler customization", err);
      updateTab(activeTabId, { customizeBusy: false });
    }
  }

  // ── Slash-command autocomplete ──

  const slashCommandQuery = tab ? parseSlashCommand(tab.input) : null;
  const commandQuery = slashCommandQuery ?? "";
  const filteredCommands = slashCommandQuery !== null && tab && tab.commands.length > 0
    ? filterCommands(tab.commands, commandQuery)
    : [];
  const commandMenuOpen = filteredCommands.length > 0;

  useEffect(() => {
    setCommandIndex(0);
    commandIndexRef.current = 0;
  }, [commandQuery, commandMenuOpen]);

  function applyCommand(name: string) {
    if (!tab) return;
    const next = applyCommandToInput(tab.input, name);
    if (next === null) return;
    setTabInput(activeTabId, next);
    setCommandIndex(0);
    commandIndexRef.current = 0;
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function closeOpenPanel(): boolean {
    if (!tab) return false;
    if (manageOpen) { setManageOpen(false); return true; }
    if (tab.historyTranscript) { updateTab(activeTabId, { historyTranscript: null }); return true; }
    if (tab.historyOpen) { updateTab(activeTabId, { historyOpen: false }); return true; }
    if (tab.customizeOpen) { updateTab(activeTabId, { customizeOpen: false }); return true; }
    return false;
  }

  function shouldExitButler() {
    const inputVal = inputValuesRef.current[activeTabId] ?? "";
    return !inputVal.trim() && !commandMenuOpen && !tab?.customizeOpen && !tab?.historyOpen && !manageOpen;
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!tab) return;
    if (commandMenuOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); const next = (commandIndex + 1) % filteredCommands.length; setCommandIndex(next); commandIndexRef.current = next; return; }
      if (e.key === "ArrowUp") { e.preventDefault(); const next = (commandIndex - 1 + filteredCommands.length) % filteredCommands.length; setCommandIndex(next); commandIndexRef.current = next; return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyCommand(filteredCommands[commandIndex].name); return; }
      if (e.key === "Escape") { e.preventDefault(); setTabInput(activeTabId, `${tab.input} `); return; }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void handleSend(); return; }
    if (e.key === "Escape") {
      if (closeOpenPanel()) { e.preventDefault(); return; }
      if (shouldExitButler()) { e.preventDefault(); onExit?.(); }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend(); }
  }

  const hasButler = tab?.butlerState?.active === true;

  useEffect(() => {
    if (!hasButler) return;

    const isSpaceEvent = (e: KeyboardEvent) => (
      e.code === "Space" || e.key === " " || e.key === "Spacebar" || (e.keyCode ?? 0) === 32
    );

    const onKeyDown = (e: KeyboardEvent) => {
      const hasCommandModifier = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if ((e.key === "Enter" && hasCommandModifier) || (key === "l" && hasCommandModifier) || (key === "p" && hasCommandModifier) || (key === "m" && hasCommandModifier) || (key === "x" && hasCommandModifier && e.shiftKey) || (key === "n" && hasCommandModifier && e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Enter") { void handleSend(); }
        else if (key === "l" || key === "x") { void handleClearContext(); }
        else if (key === "p") { cycleProfile(); }
        else if (key === "m") { cycleModel(); }
        else if (key === "n") { void handleNewSession(); }
        return;
      }

      if (e.key === "Escape") {
        if (closeOpenPanel()) { e.preventDefault(); e.stopPropagation(); return; }
        if (shouldExitButler()) { e.preventDefault(); e.stopPropagation(); onExit?.(); return; }
      }

      const hasCtrl = e.ctrlKey || e.getModifierState?.("Control");
      if (!isSpaceEvent(e) || !hasCtrl || e.altKey || e.metaKey || e.shiftKey || e.repeat) return;

      e.preventDefault();
      if (voiceButtonRef.current && !voiceButtonRef.current.isRecording()) {
        hasDictatedRef.current = false;
        setIsDictating(true);
        voiceButtonRef.current.start();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!isSpaceEvent(e)) return;
      if (!voiceButtonRef.current || !voiceButtonRef.current.isRecording()) { setIsDictating(false); return; }
      e.preventDefault();
      setIsDictating(false);
      voiceButtonRef.current.stop();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      setIsDictating(false);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasButler, tab, activeTabId, commandMenuOpen, commandIndex, filteredCommands, manageOpen, onExit]);

  // ── Render ──

  if (loadingState) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500">
        <div className="flex items-center gap-2">
          <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
          <span className="text-sm">Loading butler...</span>
        </div>
      </div>
    );
  }

  // Butlers available to add as new tabs (not already open, limited by max).
  const availableToOpen = butlers.filter((b) => !openTabs.includes(b.id));
  const canOpenMore = openTabs.length < butlerMax && availableToOpen.length > 0;

  return (
    <ButlerViewBody
      {...{
        activeModelOptions,
        activeTabId,
        addTabOpen,
        addTabRef,
        appendVoiceTranscript,
        applyCommand,
        availableToOpen,
        backendLabel,
        canOpenMore,
        closeTab,
        columns,
        commandIndex,
        commandIndexRef,
        commandMenuOpen,
        fetchButlers,
        filteredCommands,
        formatRelativeTs,
        formatWindow,
        handleClearContext,
        handleKeyDown,
        handleModelChange,
        handleProfileChange,
        handleSend,
        handleStart,
        handleStop,
        hasButler,
        hasDictatedRef,
        inputRef,
        inputValuesRef,
        interimVoiceText,
        isDictating,
        liveActivity,
        liveStats,
        manageOpen,
        messagesEndRef,
        modelSelectRef,
        onIssueClick,
        openCustomize,
        openHistory,
        openHistoryTranscript,
        openTab,
        openTabs,
        profileSelectRef,
        projectId,
        renameButler,
        renamingTabId,
        sanitizeSpeechText,
        saveCustomize,
        setActiveTabId,
        setAddTabOpen,
        setCommandIndex,
        setInterimVoiceText,
        setIsDictating,
        setManageOpen,
        setRenamingTabId,
        setTabInput,
        tab,
        tabStates,
        updateTab,
        voiceButtonRef,
        voiceInterimRef,
      }}
    />
  );
}
