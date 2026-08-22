import { createRef, type ComponentProps } from "react";
import type { ButlerViewBody } from "../../components/ButlerViewBody.js";
import type { TabState } from "../../lib/butler-types.js";
import type { ButlerChatMessage } from "../../lib/butler-event-reducer.js";

/**
 * Fixture builders for `ButlerViewBody` (#782) — the client's genuinely wide-prop component,
 * at 66 props threaded from its container.
 *
 * That width is why it had no test: a static render is possible (`renderToStaticMarkup` needs
 * no jsdom), but the setup was the entire cost. `ComponentProps<typeof ButlerViewBody>` is used
 * rather than the component's own `ButlerViewBodyProps`, which is not exported — so this
 * fixture cannot drift from the component's signature: adding a required prop makes this file
 * fail to typecheck, which is the intended alarm.
 *
 * Every handler is a no-op and every ref is a fresh null ref; a test overrides only the props
 * whose rendering it is about.
 */

type Props = ComponentProps<typeof ButlerViewBody>;

/** One message in a butler conversation. `ts` is relative to now, never a hardcoded ISO. */
export function butlerChatMessageFixture(overrides: Partial<ButlerChatMessage> = {}): ButlerChatMessage {
  return {
    id: "msg-1",
    role: "user",
    text: "what is stuck?",
    ts: Date.now() - 60_000,
    ...overrides,
  };
}

/** A per-tab state with an empty conversation — the state a freshly opened butler tab is in. */
export function butlerTabStateFixture(overrides: Partial<TabState> = {}): TabState {
  return {
    butlerId: "butler-1",
    butlerName: "Butler",
    chatMessages: [],
    butlerState: null,
    backend: "claude",
    contextTokens: 0,
    model: "sonnet",
    contextWindow: 200_000,
    mcpConnected: true,
    selectedModel: "sonnet",
    sending: false,
    input: "",
    profiles: ["default"],
    selectedProfile: "default",
    globalProfile: "default",
    commands: [],
    historyOpen: false,
    historySessions: [],
    historyLoading: false,
    historyTranscript: null,
    customizeOpen: false,
    customizePrompt: "",
    customizeBusy: false,
    ...overrides,
  };
}

/**
 * Every `ButlerViewBody` prop, with one open tab. Override what the case is about.
 *
 * Defaults are the "quiet" values — no menus open, nothing dictating, no live activity — so a
 * test that asserts a menu renders has said so explicitly in its own override list.
 */
export function butlerViewBodyPropsFixture(overrides: Partial<Props> = {}): Props {
  const tab = butlerTabStateFixture();
  const noop = () => {};
  const asyncNoop = async () => {};
  return {
    activeModelOptions: [{ value: "sonnet", label: "Sonnet" }],
    activeTabId: tab.butlerId,
    addTabOpen: false,
    addTabRef: createRef<HTMLDivElement>(),
    appendVoiceTranscript: noop,
    applyCommand: noop,
    availableToOpen: [],
    backendLabel: (backend?: string) => backend ?? "Claude",
    canOpenMore: true,
    closeTab: noop,
    columns: [],
    commandIndex: 0,
    commandIndexRef: { current: 0 },
    commandMenuOpen: false,
    fetchButlers: async () => [],
    filteredCommands: [],
    formatRelativeTs: () => "just now",
    formatWindow: (n: number) => String(n),
    handleClearContext: asyncNoop,
    handleKeyDown: noop,
    handleModelChange: asyncNoop,
    handleProfileChange: asyncNoop,
    handleAnswerQuestion: asyncNoop,
    handleSend: asyncNoop,
    handleStart: asyncNoop,
    handleStop: asyncNoop,
    hasButler: true,
    hasDictatedRef: { current: false },
    inputRef: createRef<HTMLTextAreaElement>(),
    inputValuesRef: { current: {} },
    interimVoiceText: "",
    isDictating: false,
    liveActivity: {},
    liveStats: {},
    manageOpen: false,
    messagesEndRef: createRef<HTMLDivElement>(),
    modelSelectRef: createRef<HTMLSelectElement>(),
    onIssueClick: noop,
    openCustomize: asyncNoop,
    openHistory: asyncNoop,
    openHistoryTranscript: asyncNoop,
    openTab: noop,
    openTabs: [tab.butlerId],
    profileSelectRef: createRef<HTMLSelectElement>(),
    projectId: "project-1",
    renameButler: asyncNoop,
    renamingTabId: null,
    sanitizeSpeechText: (value: string) => value,
    saveCustomize: asyncNoop,
    setActiveTabId: noop,
    setAddTabOpen: noop,
    setCommandIndex: noop,
    setInterimVoiceText: noop,
    setIsDictating: noop,
    setManageOpen: noop,
    setRenamingTabId: noop,
    setTabInput: noop,
    tab,
    tabStates: { [tab.butlerId]: tab },
    updateTab: noop,
    voiceButtonRef: createRef(),
    voiceInterimRef: { current: "" },
    ...overrides,
  };
}
