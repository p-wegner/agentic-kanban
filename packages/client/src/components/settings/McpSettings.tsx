import { MCP_TOOL_CATEGORIES, MCP_TOOL_DEFINITIONS } from "@agentic-kanban/shared/lib";
import { ToolToggle, formatHealthTime, statusClasses, type McpHealth } from "../SettingsPanel.shared.js";

type McpSettingsProps = {
  mcpHealth: McpHealth | null;
  mcpProbing: boolean;
  onMcpProbe: () => void;
  isToolDisabled: (name: string) => boolean;
  toggleTool: (name: string, disabled: boolean) => void;
};

export function McpSettings({ mcpHealth, mcpProbing, onMcpProbe: handleMcpProbe, isToolDisabled, toggleTool }: McpSettingsProps) {
  return (
<div className="space-y-4">
                  <div className="border border-gray-200 dark:border-gray-700 rounded-md overflow-hidden">
                    <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-gray-800 dark:text-gray-200">MCP connection health</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">Validates that the local MCP server starts and responds to tools/list.</div>
                      </div>
                      <button
                        type="button"
                        onClick={handleMcpProbe}
                        disabled={mcpProbing}
                        className="shrink-0 text-xs px-2.5 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
                      >
                        {mcpProbing ? "Probing..." : "Probe"}
                      </button>
                    </div>
                    <div className="px-3 py-3 space-y-3">
                      {mcpHealth ? (
                        <>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                            <div>
                              <div className="text-gray-500 dark:text-gray-400">Server</div>
                              <div className="font-mono text-gray-800 dark:text-gray-200 break-all">{mcpHealth.server.name}</div>
                            </div>
                            <div>
                              <div className="text-gray-500 dark:text-gray-400">Command</div>
                              <div className="font-mono text-gray-800 dark:text-gray-200 break-all">{mcpHealth.server.command}</div>
                            </div>
                            <div>
                              <div className="text-gray-500 dark:text-gray-400">Path</div>
                              <div className="font-mono text-gray-800 dark:text-gray-200 break-all">{mcpHealth.server.path || "not detected"}</div>
                            </div>
                            <div>
                              <div className="text-gray-500 dark:text-gray-400">Working directory</div>
                              <div className="font-mono text-gray-800 dark:text-gray-200 break-all">{mcpHealth.server.cwd || "current process"}</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${statusClasses(mcpHealth.lastProbe?.status ?? "unknown")}`}>
                              {mcpHealth.lastProbe ? mcpHealth.lastProbe.status : "not probed"}
                            </span>
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              Tool count: {mcpHealth.lastProbe?.toolCount ?? "unknown"}
                            </span>
                            {mcpHealth.lastProbe && (
                              <span className="text-xs text-gray-500 dark:text-gray-400">
                                Last probe {formatHealthTime(mcpHealth.lastProbe.checkedAt)} in {mcpHealth.lastProbe.durationMs}ms
                              </span>
                            )}
                          </div>
                          {mcpHealth.lastProbe?.error && (
                            <div className="space-y-1">
                              <div className="text-xs font-medium text-red-700 dark:text-red-300">
                                {mcpHealth.lastProbe.error.code}: {mcpHealth.lastProbe.error.message}
                              </div>
                              {mcpHealth.lastProbe.error.detail && (
                                <div className="text-xs text-red-600 dark:text-red-400 font-mono break-all">{mcpHealth.lastProbe.error.detail}</div>
                              )}
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="text-sm text-gray-500 dark:text-gray-400">MCP health is unavailable.</div>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-gray-500">
                    Enable or disable individual MCP tools. Disabled tools won't be registered with the MCP server and won't be available to connected AI agents. Requires MCP server restart to take effect.
                  </p>
                  {MCP_TOOL_CATEGORIES.map((cat) => {
                    const catTools = MCP_TOOL_DEFINITIONS.filter((t) => t.category === cat.id);
                    return (
                      <div key={cat.id}>
                        <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">{cat.label}</h4>
                        <div className="space-y-1.5">
                          {catTools.map((tool) => (
                            <ToolToggle
                              key={tool.name}
                              name={tool.name}
                              description={tool.description}
                              disabled={isToolDisabled(tool.name)}
                              onToggle={(disabled) => toggleTool(tool.name, disabled)}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
  );
}
