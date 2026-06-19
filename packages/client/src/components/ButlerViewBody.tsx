/* eslint-disable @typescript-eslint/no-explicit-any */
// Presentational render for ButlerView (container/presenter split). All session
// state, handlers and refs are threaded in via props with the SAME names as the
// container's locals (passed by shorthand spread, so mis-pairing is impossible),
// making the JSX below a verbatim, behaviour-preserving move.
import { AgentQuestionsPanel } from "./AgentQuestionsPanel.js";
import { ButlerVoiceButton } from "./ButlerVoiceButton.js";
import { ButlerManageModal } from "./ButlerManageModal.js";
import { ChatBubble } from "./ButlerChatParts.js";
import { ActivityStrip } from "./ButlerChrome.js";
import { ButlerTabBar } from "./ButlerTabBar.js";

interface ButlerViewBodyProps {
  activeModelOptions: any;
  activeTabId: any;
  addTabOpen: any;
  addTabRef: any;
  appendVoiceTranscript: any;
  applyCommand: any;
  availableToOpen: any;
  backendLabel: any;
  canOpenMore: any;
  closeTab: any;
  columns: any;
  commandIndex: any;
  commandIndexRef: any;
  commandMenuOpen: any;
  fetchButlers: any;
  filteredCommands: any;
  formatRelativeTs: any;
  formatWindow: any;
  handleClearContext: any;
  handleKeyDown: any;
  handleModelChange: any;
  handleProfileChange: any;
  handleSend: any;
  handleStart: any;
  handleStop: any;
  hasButler: any;
  hasDictatedRef: any;
  inputRef: any;
  inputValuesRef: any;
  interimVoiceText: any;
  isDictating: any;
  liveActivity: any;
  liveStats: any;
  manageOpen: any;
  messagesEndRef: any;
  modelSelectRef: any;
  onIssueClick: any;
  openCustomize: any;
  openHistory: any;
  openHistoryTranscript: any;
  openTab: any;
  openTabs: any;
  profileSelectRef: any;
  projectId: any;
  renameButler: any;
  renamingTabId: any;
  sanitizeSpeechText: any;
  saveCustomize: any;
  setActiveTabId: any;
  setAddTabOpen: any;
  setCommandIndex: any;
  setInterimVoiceText: any;
  setIsDictating: any;
  setManageOpen: any;
  setRenamingTabId: any;
  setTabInput: any;
  tab: any;
  tabStates: any;
  updateTab: any;
  voiceButtonRef: any;
  voiceInterimRef: any;
}

export function ButlerViewBody({
    activeModelOptions,   activeTabId,   addTabOpen,   addTabRef,   appendVoiceTranscript,   
  applyCommand,   availableToOpen,   backendLabel,   canOpenMore,   closeTab,   columns,   
  commandIndex,   commandIndexRef,   commandMenuOpen,   fetchButlers,   filteredCommands,   
  formatRelativeTs,   formatWindow,   handleClearContext,   handleKeyDown,   handleModelChange,   
  handleProfileChange,   handleSend,   handleStart,   handleStop,   hasButler,   hasDictatedRef,   
  inputRef,   inputValuesRef,   interimVoiceText,   isDictating,   liveActivity,   liveStats,   
  manageOpen,   messagesEndRef,   modelSelectRef,   onIssueClick,   openCustomize,   openHistory,   
  openHistoryTranscript,   openTab,   openTabs,   profileSelectRef,   projectId,   renameButler,   
  renamingTabId,   sanitizeSpeechText,   saveCustomize,   setActiveTabId,   setAddTabOpen,   
  setCommandIndex,   setInterimVoiceText,   setIsDictating,   setManageOpen,   setRenamingTabId,   
  setTabInput,   tab,   tabStates,   updateTab,   voiceButtonRef,   voiceInterimRef, }: ButlerViewBodyProps) {
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <ActivityStrip columns={columns} liveActivity={liveActivity} liveStats={liveStats} onIssueClick={onIssueClick} />

      {/* ── Tab bar ── */}
      <ButlerTabBar
        openTabs={openTabs}
        tabStates={tabStates}
        activeTabId={activeTabId}
        setActiveTabId={setActiveTabId}
        renamingTabId={renamingTabId}
        setRenamingTabId={setRenamingTabId}
        onRename={renameButler}
        onCloseTab={closeTab}
        canOpenMore={canOpenMore}
        addTabRef={addTabRef}
        addTabOpen={addTabOpen}
        setAddTabOpen={setAddTabOpen}
        availableToOpen={availableToOpen}
        onOpenTab={openTab}
        onManage={() => setManageOpen(true)}
      />

      {/* ── Tab content ── */}
      {!tab ? (
        <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500 text-sm">
          No butler tab open.
        </div>
      ) : !hasButler ? (
        <>
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="text-center max-w-sm">
              <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-brand-600 flex items-center justify-center shadow-lg">
                <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-ink dark:text-stone-100 mb-2 heading-serif">
                {tab.butlerName}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                A persistent {backendLabel(tab.backend)} agent that lives in your repository. Ask questions, get summaries, or run quick tasks — all without creating a new workspace.
              </p>
              <button
                onClick={handleStart}
                disabled={tab.sending}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 shadow-sm"
              >
                {tab.sending ? (
                  <>
                    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                    Starting butler...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <polygon points="5,3 19,12 5,21" fill="currentColor" stroke="none" />
                    </svg>
                    Start Butler
                  </>
                )}
              </button>
            </div>
          </div>
          <AgentQuestionsPanel projectId={projectId} />
        </>
      ) : (
        <>
          {/* Butler toolbar: context pill + model/profile/clear (scoped to this tab) */}
          <div className="shrink-0 flex items-center justify-between gap-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/40 px-4 py-2 text-xs">
            <div className="flex items-center gap-2 shrink-0 min-w-0">
              <div className="flex items-center shrink-0 min-w-0 rounded-full border border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark overflow-hidden">
                <div
                  className="flex items-center gap-1.5 px-3 py-1 text-gray-600 dark:text-gray-300 min-w-0"
                  title={[
                    `Backend: ${backendLabel(tab.backend)}`,
                    tab.model ? `Model: ${tab.model}` : null,
                    tab.contextWindow ? `Context window: ${(tab.contextWindow / 1000).toFixed(0)}k tokens` : null,
                    tab.contextTokens ? `Context used: ${tab.contextTokens.toLocaleString('en-US')} tokens` : null,
                    tab.mcpConnected !== undefined ? `Board MCP: ${tab.mcpConnected ? "connected" : "not connected"}` : null,
                  ].filter(Boolean).join("\n")}
                >
                  {tab.mcpConnected !== undefined && (
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tab.mcpConnected ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"}`} title={tab.mcpConnected ? "Board MCP connected" : "Board MCP not connected"} />
                  )}
                  <span className="shrink-0 font-medium">
                    {tab.contextTokens > 0
                      ? tab.contextWindow
                        ? `${(tab.contextTokens / 1000).toFixed(1)}k / ${formatWindow(tab.contextWindow)} (${Math.round((tab.contextTokens / tab.contextWindow) * 100)}%)`
                        : `${(tab.contextTokens / 1000).toFixed(1)}k context`
                      : `${backendLabel(tab.backend)} session`}
                  </span>
                </div>
                <button
                  onClick={handleClearContext}
                  disabled={tab.sending}
                  className="inline-flex items-center gap-1 border-l border-gray-200 dark:border-gray-700 px-2.5 py-1 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                  title="Clear this butler's conversation context and start fresh (Ctrl+L)"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z" />
                  </svg>
                  <span>Clear</span>
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <ButlerVoiceButton
                ref={voiceButtonRef}
                variant="prominent"
                disabled={tab.sending}
                onStart={() => {
                  hasDictatedRef.current = false;
                  voiceInterimRef.current = "";
                  setInterimVoiceText("");
                  setIsDictating(true);
                }}
                onTranscript={appendVoiceTranscript}
                onInterim={(value) => {
                  const safeInterim = sanitizeSpeechText(value);
                  setInterimVoiceText(safeInterim);
                  if (safeInterim) voiceInterimRef.current = safeInterim;
                }}
                onStop={() => {
                  setIsDictating(false);
                  const safeInterim = sanitizeSpeechText(voiceInterimRef.current);
                  if (!hasDictatedRef.current && safeInterim) {
                    const prev = inputValuesRef.current[activeTabId] ?? "";
                    const sep = prev.length > 0 && !/\s$/.test(prev) ? " " : "";
                    setTabInput(activeTabId, safeInterim ? `${prev + sep}${safeInterim} ` : prev);
                    hasDictatedRef.current = true;
                  }
                  voiceInterimRef.current = "";
                  setInterimVoiceText("");
                  requestAnimationFrame(() => {
                    if (!inputRef.current) return;
                    inputRef.current.focus();
                    const len = inputRef.current.value.length;
                    inputRef.current.setSelectionRange(len, len);
                  });
                }}
              />
              <span className="h-5 w-px bg-gray-300 dark:bg-gray-700" aria-hidden />
              <label className="flex items-center gap-1 text-gray-500 dark:text-gray-400" title="Model for this butler tab. Switches without losing context.">
                <span className="hidden sm:inline text-[11px]">Model</span>
                <select
                  ref={modelSelectRef}
                  value={tab.selectedModel}
                  onChange={(e) => void handleModelChange(e.target.value)}
                  title="Model for this butler. Ctrl+M cycles models without losing context."
                  className="rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-1.5 py-1 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  {activeModelOptions.map((m: any) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1 text-gray-500 dark:text-gray-400" title={`${backendLabel(tab.backend)} profile. Switching restarts this butler tab with a fresh context.`}>
                <span className="hidden sm:inline text-[11px]">Profile</span>
                <select
                  ref={profileSelectRef}
                  value={tab.selectedProfile}
                  onChange={(e) => void handleProfileChange(e.target.value)}
                  disabled={tab.sending}
                  title={`${backendLabel(tab.backend)} profile. Ctrl+P cycles profiles and restarts the butler fresh.`}
                  className="rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-1.5 py-1 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
                >
                  <option value="">{tab.globalProfile ? `Default (${tab.globalProfile})` : "Default"}</option>
                  {tab.profiles.map((p: any) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>
              <span className="h-5 w-px bg-gray-300 dark:bg-gray-700" aria-hidden />
              <button
                onClick={openCustomize}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors shadow-sm"
                title="Customize the butler's behavior (edits the project's butler skill)"
              >
                <span aria-hidden>Config</span>
                <span>Customize</span>
              </button>
              <button
                onClick={() => void openHistory()}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors shadow-sm ${tab.historyOpen ? "bg-gray-100 dark:bg-gray-700" : ""}`}
                title="View recent butler sessions"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <span>History</span>
              </button>
            </div>
          </div>

          {tab.customizeOpen && (
            <div className="shrink-0 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60 px-4 py-3">
              <div className="max-w-3xl mx-auto">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Butler behavior (project override)</span>
                  <span className="text-[10px] text-gray-400 dark:text-gray-500">Placeholders: {"{{projectName}}"}, {"{{repoPath}}"}, {"{{serverPort}}"}</span>
                </div>
                <textarea
                  value={tab.customizePrompt}
                  onChange={(e) => updateTab(activeTabId, { customizePrompt: e.target.value })}
                  disabled={tab.customizeBusy}
                  rows={8}
                  className="w-full resize-y rounded-lg border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-3 py-2 text-xs font-mono text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
                  placeholder="Leave empty to revert to the default butler behavior."
                />
                <div className="flex items-center justify-end gap-2 mt-2">
                  <button onClick={() => updateTab(activeTabId, { customizeOpen: false })} disabled={tab.customizeBusy} className="px-3 py-1.5 text-xs rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">Cancel</button>
                  <button onClick={saveCustomize} disabled={tab.customizeBusy} className="px-3 py-1.5 text-xs rounded-lg bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50">
                    {tab.customizeBusy ? "Saving..." : "Save & apply"}
                  </button>
                </div>
                <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">Saving clears the current context so the new behavior takes effect immediately.</p>
              </div>
            </div>
          )}

          {tab.historyOpen && (
            <div className="shrink-0 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60">
              {tab.historyTranscript ? (
                <div className="flex flex-col max-h-[60vh]">
                  <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700">
                    <div className="flex items-center gap-2 min-w-0">
                      <button
                        onClick={() => updateTab(activeTabId, { historyTranscript: null })}
                        className="shrink-0 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
                        title="Back to session list"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
                      </button>
                      <span className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate">{tab.historyTranscript.session.title}</span>
                      <span className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500">
                        {tab.historyTranscript.session.turnCount} turns · {formatRelativeTs(new Date(tab.historyTranscript.session.startedAt).getTime())}
                      </span>
                    </div>
                    <button onClick={() => updateTab(activeTabId, { historyOpen: false })} className="shrink-0 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 dark:text-gray-500" title="Close history">
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                    </button>
                  </div>
                  <div className="overflow-y-auto px-4 py-3 flex-1">
                    {tab.historyTranscript.messages.length === 0 ? (
                      <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-4">No messages found in this session.</p>
                    ) : (
                      <div className="max-w-3xl mx-auto">
                        {tab.historyTranscript.messages.map((msg: any, i: number) => (
                          <ChatBubble key={i} msg={{ id: `hist-${i}`, role: msg.role, text: msg.text, ts: msg.ts }} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="px-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Recent sessions</span>
                    <button onClick={() => updateTab(activeTabId, { historyOpen: false })} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 dark:text-gray-500" title="Close">
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                    </button>
                  </div>
                  {tab.historyLoading ? (
                    <p className="text-xs text-gray-400 dark:text-gray-500 py-2">Loading...</p>
                  ) : tab.historySessions.length === 0 ? (
                    <p className="text-xs text-gray-400 dark:text-gray-500 py-2">No past butler sessions found.</p>
                  ) : (
                    <div className="space-y-1">
                      {tab.historySessions.map((s: any) => (
                        <button
                          key={s.sessionId}
                          onClick={() => void openHistoryTranscript(s)}
                          className="w-full text-left flex items-center justify-between gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                        >
                          <span className="text-xs text-gray-800 dark:text-gray-200 truncate">{s.title}</span>
                          <div className="shrink-0 flex items-center gap-2 text-[10px] text-gray-400 dark:text-gray-500">
                            <span>{s.turnCount}t</span>
                            <span>{formatRelativeTs(new Date(s.startedAt).getTime())}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
            {tab.chatMessages.length === 0 && (
              <div className="flex items-center justify-center h-full text-center">
                <div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Butler is ready.</p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Ask anything about your project or the board.</p>
                </div>
              </div>
            )}
            <div className="max-w-3xl mx-auto">
              {tab.chatMessages.map((msg: any) => (
                <ChatBubble key={msg.id} msg={msg} />
              ))}
              {tab.sending && (
                <div className="flex justify-start mb-3">
                  <div className="bg-surface-raised dark:bg-surface-raised-dark border border-gray-200 dark:border-gray-700 rounded-2xl rounded-tl-md px-4 py-2.5 flex items-center gap-1.5 shadow-sm">
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-500 animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-500 animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-500 animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="shrink-0 border-t border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark px-4 py-3">
            <div className="max-w-3xl mx-auto flex items-end gap-2">
              <div className="flex-1 relative">
                {commandMenuOpen && (
                  <div className="absolute bottom-full mb-2 left-0 right-0 max-h-60 overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark shadow-lg z-10 py-1">
                    <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">Commands</div>
                    {filteredCommands.map((cmd: any, i: number) => (
                      <button
                        key={cmd.name}
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); applyCommand(cmd.name); }}
                        onMouseEnter={() => { setCommandIndex(i); commandIndexRef.current = i; }}
                        className={`w-full text-left px-3 py-1.5 flex items-baseline gap-2 ${i === commandIndex ? "bg-brand-50 dark:bg-brand-900/30" : "hover:bg-gray-50 dark:hover:bg-gray-700/50"}`}
                      >
                        <span className="text-sm font-mono text-brand-600 dark:text-brand-400 shrink-0">/{cmd.name}</span>
                        {cmd.argumentHint && <span className="text-[11px] text-gray-400 dark:text-gray-500 shrink-0">{cmd.argumentHint}</span>}
                        {cmd.description && <span className="text-xs text-gray-500 dark:text-gray-400 truncate">{cmd.description}</span>}
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  ref={inputRef}
                  value={tab.input}
                  onChange={(e) => setTabInput(activeTabId, e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={tab.sending}
                  rows={1}
                  placeholder="Message the butler... (Enter or Ctrl+Enter to send, Shift+Enter for new line, / for commands)"
                  className="block w-full resize-none rounded-xl border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-4 py-2.5 pr-10 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-500 dark:focus:ring-brand-600 transition-all disabled:opacity-50"
                  style={{ minHeight: "42px", maxHeight: "160px", overflowY: "auto" }}
                  onInput={(e) => {
                    const t = e.target as HTMLTextAreaElement;
                    t.style.height = "auto";
                    t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
                  }}
                />
                {interimVoiceText && (
                  <div className="absolute bottom-full mb-1 left-0 right-0 z-10 rounded-md bg-gray-900/90 dark:bg-gray-100/90 px-2.5 py-1 text-xs italic text-white dark:text-gray-900 pointer-events-none">
                    [voice] {interimVoiceText}
                  </div>
                )}
              </div>
              {tab.sending ? (
                <button
                  onClick={handleStop}
                  className="shrink-0 p-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white transition-colors shadow-sm"
                  title="Stop the butler"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={() => void handleSend()}
                  disabled={!tab.input.trim()}
                  className="shrink-0 p-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm"
                  title="Send message"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                  </svg>
                </button>
              )}
            </div>
            <p className="max-w-3xl mx-auto mt-1 text-[10px] text-gray-400 dark:text-gray-500">
              {tab.sending ? (
                <span className="flex items-center gap-1">
                  <svg className="animate-spin w-2.5 h-2.5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Butler is thinking...
                </span>
              ) : (
                <span className={`flex items-center gap-1.5 ${isDictating ? "text-red-500 dark:text-red-400" : ""}`}>
                  <span>
                    {isDictating
                      ? "Dictating in progress"
                      : "Persistent warm butler runs in your project repo. Enter or Ctrl + Enter sends. Ctrl + L clears context. Hold Ctrl + Space to dictate."}
                  </span>
                  {isDictating && <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />}
                </span>
              )}
            </p>
          </div>

          <AgentQuestionsPanel projectId={projectId} />
        </>
      )}
      {manageOpen && (
        <ButlerManageModal
          globalBackend={tab?.backend ?? "claude"}
          onClose={() => setManageOpen(false)}
          onChanged={() => { void fetchButlers(); }}
        />
      )}
    </div>
  );
}
