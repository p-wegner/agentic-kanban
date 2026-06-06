import type { Dispatch, SetStateAction } from "react";
import { CLAUDE_MODEL_OPTIONS, CODEX_MODEL_OPTIONS } from "@agentic-kanban/shared";
import { CODEX_DEFAULT_PROFILE, COPILOT_DEFAULT_PROFILE, CapabilityMatrixTable, Field, defaultHarnessLabel, formatHealthTime, profileOptionLabel, providerDisplayName, settingsProfileValue, statusClasses, type AgentProfileHealth, type Settings, type SettingsTextSetter } from "../SettingsPanel.shared.js";

type AgentSettingsProps = {
  settings: Settings;
  set: SettingsTextSetter;
  setSettings: Dispatch<SetStateAction<Settings>>;
  profiles: string[];
  codexProfiles: string[];
  copilotProfiles: string[];
  profileHealth: AgentProfileHealth[];
  preflightingProfileId: string | null;
  onProfilePreflight: (profile: AgentProfileHealth) => void;
};

export function AgentSettings({ settings, set, setSettings, profiles, codexProfiles, copilotProfiles, profileHealth, preflightingProfileId, onProfilePreflight: handleProfilePreflight }: AgentSettingsProps) {
  return (
<>
                  <Field label="Agent Command" hint="Binary name or path. Leave empty for default (claude). Examples: claude, claude-glm, /usr/local/bin/claude">
                    <input
                      type="text"
                      value={settings.agent_command || ""}
                      onChange={(e) => set("agent_command")(e.target.value)}
                      placeholder="claude"
                      className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />
                  </Field>
                  <Field label="Agent Profile" hint="Selects agent provider and profile. Claude uses ~/.claude/settings_*.json, Codex uses ~/.codex/<name>.config.toml, Copilot uses the CLI default or configured model profile.">
                    <select
                      value={settingsProfileValue(settings)}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "") {
                          setSettings((s) => ({ ...s, provider: "claude", claude_profile: "", codex_profile: s.codex_profile, copilot_profile: s.copilot_profile }));
                        } else {
                          const [prov, name] = val.split(":");
                          if (prov === "codex") {
                            setSettings((s) => ({ ...s, provider: "codex", codex_profile: name === CODEX_DEFAULT_PROFILE ? "" : name, claude_profile: s.claude_profile, copilot_profile: s.copilot_profile }));
                          } else if (prov === "copilot") {
                            setSettings((s) => ({ ...s, provider: "copilot", copilot_profile: name === COPILOT_DEFAULT_PROFILE ? "" : name, claude_profile: s.claude_profile, codex_profile: s.codex_profile }));
                          } else {
                            setSettings((s) => ({ ...s, provider: "claude", claude_profile: name, codex_profile: s.codex_profile, copilot_profile: s.copilot_profile }));
                          }
                        }
                      }}
                      className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500"
                    >
                      <option value="">Default ({defaultHarnessLabel(settings)})</option>
                      <optgroup label="Claude">
                        {profiles.map((p) => (
                          <option key={`claude:${p}`} value={`claude:${p}`}>{profileOptionLabel("claude", p)}</option>
                        ))}
                      </optgroup>
                      <optgroup label="Codex">
                        {codexProfiles.map((p) => (
                          <option key={`codex:${p}`} value={`codex:${p}`}>{profileOptionLabel("codex", p)}</option>
                        ))}
                      </optgroup>
                      <optgroup label="Copilot">
                        {copilotProfiles.map((p) => (
                          <option key={`copilot:${p}`} value={`copilot:${p}`}>{profileOptionLabel("copilot", p)}</option>
                        ))}
                      </optgroup>
                    </select>
                  </Field>
                  <Field label="Default Model" hint="Default model for new workspaces (passed via --model). Options follow the selected provider (Claude or Codex). Per-workspace selection overrides this. Ignored for Claude profiles with a custom endpoint (e.g. z.ai) and for Copilot.">
                    <select
                      value={settings.default_model || ""}
                      onChange={(e) => set("default_model")(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500"
                    >
                      {(settings.provider === "codex" ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS).map((m) => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Additional Arguments" hint="Extra CLI arguments passed to the agent command. Arguments are shell-split (supports quoting).">
                    <input
                      type="text"
                      value={settings.agent_args || ""}
                      onChange={(e) => set("agent_args")(e.target.value)}
                      placeholder="--model opus --settings .claude/settings.json"
                      className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />
                  </Field>

                  <div className="border border-gray-200 dark:border-gray-700 rounded-md overflow-hidden">
                    <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
                      <div className="text-sm font-medium text-gray-800 dark:text-gray-200">Provider capability</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">Configured profiles, launch flags, and last launch failure.</div>
                    </div>
                    {profileHealth.length === 0 ? (
                      <div className="px-3 py-4 text-sm text-gray-500 dark:text-gray-400">No provider profiles found.</div>
                    ) : (
                      <div className="divide-y divide-gray-100 dark:divide-gray-800">
                        {profileHealth.map((profile) => (
                          <div key={profile.id} className="px-3 py-3 space-y-2">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{providerDisplayName(profile.provider)}</span>
                                  <span className="text-xs font-mono text-gray-500 dark:text-gray-400">{profile.profileName}</span>
                                  {profile.selected && <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300">selected</span>}
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${statusClasses(profile.status)}`}>{profile.status}</span>
                                </div>
                                <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                  Command: <span className="font-mono">{profile.command || profile.provider}</span>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleProfilePreflight(profile)}
                                disabled={preflightingProfileId === profile.id}
                                className="shrink-0 text-xs px-2.5 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
                              >
                                {preflightingProfileId === profile.id ? "Checking..." : "Preflight"}
                              </button>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {profile.preflight.flags.length === 0 ? (
                                <span className="text-xs text-gray-400">No launch flags</span>
                              ) : profile.preflight.flags.map((flag) => (
                                <span key={flag} className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">{flag}</span>
                              ))}
                            </div>
                            <CapabilityMatrixTable provider={profile.provider} profileName={profile.profileName} flags={profile.preflight.flags} />
                            {(profile.preflight.errors.length > 0 || profile.preflight.warnings.length > 0) && (
                              <div className="space-y-1">
                                {profile.preflight.errors.map((error) => (
                                  <div key={error} className="text-xs text-red-600 dark:text-red-400">{error}</div>
                                ))}
                                {profile.preflight.warnings.map((warning) => (
                                  <div key={warning} className="text-xs text-amber-600 dark:text-amber-400">{warning}</div>
                                ))}
                              </div>
                            )}
                            {profile.latestFailure ? (
                              <div className="text-xs text-red-700 dark:text-red-300">
                                Last failure {formatHealthTime(profile.latestFailure.at)}: {profile.latestFailure.summary}
                              </div>
                            ) : (
                              <div className="text-xs text-gray-400">No launch failures recorded.</div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
  );
}
