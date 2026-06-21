import type { Dispatch, SetStateAction } from "react";
import { apiFetch, apiPost } from "../../lib/api.js";
import { ProjectScriptsSettingsSection } from "../ProjectScriptsSettingsSection.js";
import { StackProfileSettingsSection } from "../StackProfileSettingsSection.js";
import { DriveSettingsSection } from "../DriveSettingsSection.js";
import { showToast } from "../Toast.js";
import { ArchiveDoneSection, CollapsibleSection, Field, Toggle, type ProjectSettingsState, type Settings, type SkillSetting } from "../SettingsPanel.shared.js";

type ConfigImportPreview = {
  statusChanges: { toAdd: unknown[]; toUpdate: unknown[] };
  prefChanges: Record<string, { from: string | undefined; to: string }>;
  strategyChanged: boolean;
  pendingFile: File;
};

type ProjectSettingsProps = {
  activeProjectId?: string | null;
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
  projectSettings: ProjectSettingsState;
  setProjectSettings: Dispatch<SetStateAction<ProjectSettingsState>>;
  projectBranches: { local: string[]; remote: string[] } | null;
  defaultBranchInvalid: boolean;
  generatingScript: boolean;
  setGeneratingScript: Dispatch<SetStateAction<boolean>>;
  generatingTeardown: boolean;
  setGeneratingTeardown: Dispatch<SetStateAction<boolean>>;
  generatingVerify: boolean;
  setGeneratingVerify: Dispatch<SetStateAction<boolean>>;
  skills: SkillSetting[];
  configExporting: boolean;
  configImporting: boolean;
  configImportPreview: ConfigImportPreview | null;
  setConfigImportPreview: Dispatch<SetStateAction<ConfigImportPreview | null>>;
  handleConfigExport: () => void;
  handleConfigImportFile: (file: File) => void;
  handleConfigImportConfirm: () => void;
};

export function ProjectSettings({ activeProjectId, settings, setSettings, projectSettings, setProjectSettings, projectBranches, defaultBranchInvalid, generatingScript, setGeneratingScript, generatingTeardown, setGeneratingTeardown, generatingVerify, setGeneratingVerify, skills, configExporting, configImporting, configImportPreview, setConfigImportPreview, handleConfigExport, handleConfigImportFile, handleConfigImportConfirm }: ProjectSettingsProps) {
  return (
<>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Projects base directory
                    </label>
                    <input
                      type="text"
                      value={settings.projects_base_path ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_path: e.target.value }))}
                      placeholder="C:/projects"
                      className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Default parent folder for new projects created via "Create new project". New projects are created as subdirectories here.
                    </p>
                  </div>
                  {!activeProjectId ? (
                    <p className="text-sm text-gray-500">No active project selected.</p>
                  ) : (
                    <div className="space-y-3">
                      <DriveSettingsSection
                        projectId={activeProjectId}
                        onChanged={async () => {
                          // Drive flips global auto_review/auto_merge — refetch so the
                          // Workflow section's mirrors don't show stale values.
                          try {
                            const fresh = await apiFetch<Settings>("/api/preferences/settings");
                            setSettings((s) => ({ ...s, ...fresh }));
                          } catch {
                            // best-effort UI refresh; the server state is already correct.
                          }
                        }}
                      />
                      <Field label="Default Branch" hint="Used as the base branch for new worktrees. Leave empty only if you do not want worktrees created until this is set.">
                        <input
                          type="text"
                          value={projectSettings.defaultBranch}
                          list="project-default-branches"
                          onChange={(e) => setProjectSettings(s => ({ ...s, defaultBranch: e.target.value }))}
                          placeholder="main"
                          className={`w-full text-sm border rounded px-2 py-1.5 focus:outline-none focus:ring-1 font-mono ${
                            defaultBranchInvalid
                              ? "border-red-300 focus:ring-red-500"
                              : "border-gray-300 focus:ring-blue-500"
                          }`}
                        />
                        {projectBranches && (
                          <datalist id="project-default-branches">
                            {projectBranches.local.map((branch) => (
                              <option key={branch} value={branch} />
                            ))}
                          </datalist>
                        )}
                        {defaultBranchInvalid ? (
                          <p className="text-xs text-red-600 mt-1">Branch must exist locally in this repository.</p>
                        ) : (
                          <p className="text-xs text-gray-500 mt-1">
                            Detected local branches: {projectBranches?.local.length ? projectBranches.local.join(", ") : "unavailable"}
                          </p>
                        )}
                      </Field>
                      <Field label="Project Color">
                        <div className="flex items-center gap-3">
                          <input
                            type="color"
                            value={projectSettings.color || "#6B7280"}
                            onChange={(e) => setProjectSettings(s => ({ ...s, color: e.target.value }))}
                            className="h-10 w-20 border border-gray-300 rounded cursor-pointer"
                          />
                          <div className="flex-1">
                            <span className="text-sm font-mono text-gray-700">{projectSettings.color || "#6B7280"}</span>
                            {projectSettings.color && (
                              <button
                                onClick={() => setProjectSettings(s => ({ ...s, color: null }))}
                                className="text-xs text-gray-500 hover:text-gray-700 block mt-1"
                              >
                                Clear color
                              </button>
                            )}
                          </div>
                        </div>
                        <p className="text-xs text-gray-500 mt-2">
                          The project color will be displayed in the project dropdown in the header.
                        </p>
                      </Field>
                      <ProjectScriptsSettingsSection projectId={activeProjectId} />
                      <StackProfileSettingsSection projectId={activeProjectId} />
                      <div className="pt-2">
                        <h3 className="text-sm font-semibold text-gray-700">Worktree Setup</h3>
                        <p className="text-xs text-gray-500 mt-1">
                          How each new worktree gets working dependencies. By default the stack's install
                          command runs in the worktree (the Setup Script below, e.g. <code>pnpm install -r</code>,{" "}
                          <code>uv sync</code>, <code>cargo fetch</code>). As a faster Windows-only alternative
                          you can junction-link dependency directories from the main checkout instead — see
                          Dependency Symlinks. Use one or the other.
                        </p>
                      </div>
                      <CollapsibleSection
                        title="Setup Script (install dependencies)"
                        configured={!!projectSettings.setupScript}
                        defaultOpen={!!projectSettings.setupScript}
                      >
                        <p className="text-xs text-gray-500">Runs in each new worktree after it is created — typically the stack's install command (<code>pnpm install -r</code>, <code>uv sync</code>, <code>cargo fetch</code>, …), auto-derived on project registration. Use && to chain multiple commands.</p>
                        <textarea
                          value={projectSettings.setupScript}
                          onChange={(e) => setProjectSettings(s => ({ ...s, setupScript: e.target.value }))}
                          placeholder="pnpm install"
                          rows={3}
                          className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
                        />
                        <button
                          onClick={async () => {
                            if (!activeProjectId || generatingScript) return;
                            setGeneratingScript(true);
                            try {
                              const result = await apiPost<{ setupScript: string }>("/api/projects/generate-setup-script", { projectId: activeProjectId });
                              if (result.setupScript) {
                                setProjectSettings(s => ({ ...s, setupScript: result.setupScript }));
                              }
                            } catch {
                              showToast("Failed to generate setup script", "error");
                            } finally {
                              setGeneratingScript(false);
                            }
                          }}
                          disabled={generatingScript || !activeProjectId}
                          className="text-xs text-brand-600 px-2 py-1.5 hover:text-brand-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                        >
                          {generatingScript ? (
                            <>
                              <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                              </svg>
                              Generating...
                            </>
                          ) : (
                            <>
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l1.5 3.5L10 8l-3.5 1.5L5 13l-1.5-3.5L0 8l3.5-1.5L5 3zM19 11l1 2.5L22.5 14l-2.5 1L19 17.5l-1-2.5L15.5 14l2.5-1L19 11z" />
                              </svg>
                              Generate with AI
                            </>
                          )}
                        </button>
                        <Toggle
                          checked={projectSettings.setupBlocking}
                          onChange={(v) => setProjectSettings(s => ({ ...s, setupBlocking: v }))}
                          label="Run setup before agent"
                          hint="When enabled, the setup script must complete before the agent starts. When disabled, both run in parallel (faster but the agent may start before dependencies are installed)."
                        />
                      </CollapsibleSection>
                      <CollapsibleSection
                        title="Dependency Symlinks (alternative to install)"
                        configured={projectSettings.symlinkEnabled}
                        defaultOpen={projectSettings.symlinkEnabled}
                      >
                        <p className="text-xs text-gray-500">
                          Opt-in, Windows-only fast-path that <strong>replaces</strong> the install above:
                          instead of running the setup script, junction-link dependency directories from the
                          main checkout into each new worktree. Saves the ~10s install at the cost of Windows
                          junction fragility, so it is off by default — prefer the install setup script.
                          Stack-agnostic: works for any directory (<code>node_modules</code>, <code>.venv</code>,
                          <code>target</code>, <code>vendor</code>, build caches). For a pnpm/yarn workspace,
                          listing <code>node_modules</code> also links each <code>packages/*/node_modules</code>
                          (deps live per-package under a strict linker). If a branch later changes its
                          dependencies, the worktree is auto-isolated (junctions removed) before install, so it
                          never corrupts the main checkout.
                        </p>
                        <Toggle
                          checked={projectSettings.symlinkEnabled}
                          onChange={(v) => setProjectSettings(s => ({ ...s, symlinkEnabled: v }))}
                          label="Use dependency symlinks instead of the install script"
                          hint="When enabled, listed directories are junction-linked from the main checkout into new worktrees on Windows, and the setup/install script is typically not needed."
                        />
                        {projectSettings.symlinkEnabled && (
                          <div className="space-y-2">
                            <label className="block text-xs font-medium text-gray-700">
                              Directories to symlink
                            </label>
                            <input
                              type="text"
                              value={projectSettings.symlinkDirs}
                              onChange={(e) => setProjectSettings(s => ({ ...s, symlinkDirs: e.target.value }))}
                              placeholder='["node_modules", ".venv"]'
                              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
                            />
                            <p className="text-xs text-gray-400">
                              JSON array of directory names relative to the repo root. These must exist in the main checkout.
                              <code>node_modules</code> auto-expands to per-package node_modules in a workspace.
                            </p>
                          </div>
                        )}
                      </CollapsibleSection>
                      <Toggle
                        checked={projectSettings.setupEnabled}
                        onChange={(v) => setProjectSettings(s => ({ ...s, setupEnabled: v }))}
                        label="Enable setup/teardown scripts"
                        hint="When disabled, setup and teardown scripts won't run even if configured. Useful for tasks that don't need dependency installation (e.g. doc-only changes)."
                      />
                      <CollapsibleSection
                        title="Teardown Script"
                        configured={!!projectSettings.teardownScript}
                        defaultOpen={!!projectSettings.teardownScript}
                      >
                        <p className="text-xs text-gray-500">Shell command(s) to run in the worktree before it is removed on merge (e.g. stop services, rm -rf node_modules).</p>
                        <textarea
                          value={projectSettings.teardownScript}
                          onChange={(e) => setProjectSettings(s => ({ ...s, teardownScript: e.target.value }))}
                          placeholder="pkill -f dev-server || true"
                          rows={3}
                          className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
                        />
                        <button
                          onClick={async () => {
                            if (!activeProjectId || generatingTeardown) return;
                            setGeneratingTeardown(true);
                            try {
                              const result = await apiPost<{ teardownScript: string }>("/api/projects/generate-teardown-script", { projectId: activeProjectId });
                              if (result.teardownScript) {
                                setProjectSettings(s => ({ ...s, teardownScript: result.teardownScript }));
                              }
                            } catch {
                              showToast("Failed to generate teardown script", "error");
                            } finally {
                              setGeneratingTeardown(false);
                            }
                          }}
                          disabled={generatingTeardown || !activeProjectId}
                          className="text-xs text-brand-600 px-2 py-1.5 hover:text-brand-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                        >
                          {generatingTeardown ? (
                            <>
                              <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                              </svg>
                              Generating...
                            </>
                          ) : (
                            <>
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l1.5 3.5L10 8l-3.5 1.5L5 13l-1.5-3.5L0 8l3.5-1.5L5 3zM19 11l1 2.5L22.5 14l-2.5 1L19 17.5l-1-2.5L15.5 14l2.5-1L19 11z" />
                              </svg>
                              Generate with AI
                            </>
                          )}
                        </button>
                      </CollapsibleSection>
                      <CollapsibleSection
                        title="Verify Script"
                        configured={!!projectSettings.verifyScript}
                        defaultOpen={!!projectSettings.verifyScript}
                      >
                        <p className="text-xs text-gray-500">Shell command(s) to run after review to confirm the code is correct. Non-zero exit withholds ready-for-merge.</p>
                        <textarea
                          value={projectSettings.verifyScript}
                          onChange={(e) => setProjectSettings(s => ({ ...s, verifyScript: e.target.value }))}
                          placeholder="pnpm test"
                          rows={3}
                          className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
                        />
                        <button
                          onClick={async () => {
                            if (!activeProjectId || generatingVerify) return;
                            setGeneratingVerify(true);
                            try {
                              const result = await apiPost<{ verifyScript: string }>("/api/projects/generate-verify-script", { projectId: activeProjectId });
                              if (result.verifyScript !== undefined) {
                                setProjectSettings(s => ({ ...s, verifyScript: result.verifyScript }));
                              }
                            } catch {
                              showToast("Failed to generate verify script", "error");
                            } finally {
                              setGeneratingVerify(false);
                            }
                          }}
                          disabled={generatingVerify || !activeProjectId}
                          className="text-xs text-brand-600 px-2 py-1.5 hover:text-brand-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                        >
                          {generatingVerify ? (
                            <>
                              <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                              </svg>
                              Generating...
                            </>
                          ) : (
                            <>
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l1.5 3.5L10 8l-3.5 1.5L5 13l-1.5-3.5L0 8l3.5-1.5L5 3zM19 11l1 2.5L22.5 14l-2.5 1L19 17.5l-1-2.5L15.5 14l2.5-1L19 11z" />
                              </svg>
                              Suggest with AI
                            </>
                          )}
                        </button>
                      </CollapsibleSection>
                      <Field label="Default Skill" hint="Skill applied to new workspaces when no explicit skill is chosen and the issue has no workflow. Fixes 'No Skill' in Insights.">
                        <select
                          value={projectSettings.defaultSkillId || ""}
                          onChange={(e) => setProjectSettings(s => ({ ...s, defaultSkillId: e.target.value || null }))}
                          className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
                        >
                          <option value="">— none —</option>
                          {skills.map((skill) => (
                            <option key={skill.id} value={skill.id}>{skill.name}</option>
                          ))}
                        </select>
                      </Field>
                      <div className="pt-4 border-t border-gray-100">
                        <ArchiveDoneSection projectId={activeProjectId} />
                      </div>
                      <div className="pt-4 border-t border-gray-100">
                        <CollapsibleSection title="Export / Import Config" configured={false} defaultOpen={false}>
                          <p className="text-xs text-gray-500 mb-3">
                            Export board configuration (statuses, strategy, workflow preferences) to a JSON file and import it on another project.
                          </p>
                          <div className="flex gap-2 flex-wrap">
                            <button
                              onClick={handleConfigExport}
                              disabled={configExporting}
                              className="text-sm px-3 py-1.5 bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                            >
                              {configExporting ? (
                                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                                </svg>
                              ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
                                </svg>
                              )}
                              Export Config
                            </button>
                            <label className="text-sm px-3 py-1.5 bg-white border border-gray-300 rounded hover:bg-gray-50 cursor-pointer flex items-center gap-1.5">
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 6l5-5 5 5M12 2v13" />
                              </svg>
                              Import Config
                              <input
                                type="file"
                                accept=".json"
                                className="hidden"
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) handleConfigImportFile(file);
                                  e.target.value = "";
                                }}
                              />
                            </label>
                          </div>
                          {configImportPreview && (
                            <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded text-sm space-y-2">
                              <p className="font-medium text-amber-800">Review changes before applying:</p>
                              {configImportPreview.statusChanges.toAdd.length > 0 && (
                                <p className="text-amber-700">
                                  Add {configImportPreview.statusChanges.toAdd.length} status(es):&nbsp;
                                  {(configImportPreview.statusChanges.toAdd as Array<{ name: string }>).map((s) => s.name).join(", ")}
                                </p>
                              )}
                              {configImportPreview.statusChanges.toUpdate.length > 0 && (
                                <p className="text-amber-700">
                                  Update sort order for {configImportPreview.statusChanges.toUpdate.length} status(es).
                                </p>
                              )}
                              {Object.keys(configImportPreview.prefChanges).length > 0 && (
                                <p className="text-amber-700">
                                  Update preferences: {Object.keys(configImportPreview.prefChanges).join(", ")}
                                </p>
                              )}
                              {configImportPreview.strategyChanged && (
                                <p className="text-amber-700">Update board strategy (Bullseye config).</p>
                              )}
                              {configImportPreview.statusChanges.toAdd.length === 0 &&
                                configImportPreview.statusChanges.toUpdate.length === 0 &&
                                Object.keys(configImportPreview.prefChanges).length === 0 &&
                                !configImportPreview.strategyChanged && (
                                  <p className="text-gray-500">No changes detected.</p>
                                )}
                              <div className="flex gap-2 pt-1">
                                <button
                                  onClick={handleConfigImportConfirm}
                                  disabled={configImporting}
                                  className="text-sm px-3 py-1.5 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
                                >
                                  {configImporting ? "Applying..." : "Apply"}
                                </button>
                                <button
                                  onClick={() => setConfigImportPreview(null)}
                                  className="text-sm px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </CollapsibleSection>
                      </div>
                      {activeProjectId && (
                        <div className="pt-4 border-t border-gray-100">
                          <CollapsibleSection
                            title="Outbound Webhook"
                            configured={!!(settings[`outbound_webhook_url_${activeProjectId}` as keyof Settings])}
                            defaultOpen={false}
                          >
                            <p className="text-xs text-gray-500 mb-3">
                              Fire a POST request to a local URL whenever an issue changes status. Only localhost / 127.0.0.1 targets are accepted.
                            </p>
                            <Field label="Webhook URL" hint="e.g. http://localhost:9000/webhook">
                              <input
                                type="url"
                                placeholder="http://localhost:9000/webhook"
                                value={settings[`outbound_webhook_url_${activeProjectId}` as keyof Settings] ?? ""}
                                onChange={(e) => setSettings((s) => ({ ...s, [`outbound_webhook_url_${activeProjectId}`]: e.target.value }))}
                                className="w-full px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
                              />
                            </Field>
                          </CollapsibleSection>
                        </div>
                      )}
                    </div>
                  )}
                </>
  );
}
