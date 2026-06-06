import type { ReactNode } from "react";
import { Field, Toggle, type Settings, type SettingsBoolSetter, type SettingsTextSetter } from "../SettingsPanel.shared.js";

type AppearanceSettingsProps = {
  boardToolsSlot?: ReactNode;
  settings: Settings;
  set: SettingsTextSetter;
  setBool: SettingsBoolSetter;
};

export function AppearanceSettings({ boardToolsSlot, settings, set, setBool }: AppearanceSettingsProps) {
  return (
<>
                {boardToolsSlot && (
                  <div className="mb-4">
                    <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-1">Board filters &amp; export</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                      Filter the board and export / import issues. Moved off the main toolbar to keep the board uncluttered.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      {boardToolsSlot}
                    </div>
                  </div>
                )}
                <Field label="Output Parsing" hint='Parses structured agent output into a compact activity timeline. Disable for debugging to see raw JSONL output.'>
                  <select
                    value={settings.output_parser || "minimal"}
                    onChange={(e) => set("output_parser")(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500"
                  >
                    <option value="minimal">Minimal activity view</option>
                    <option value="false">Show raw output (debug)</option>
                  </select>
                </Field>
                <div className="space-y-3 mt-4">
                  <Toggle
                    checked={settings.dynamic_column_scaling === "true"}
                    onChange={setBool("dynamic_column_scaling")}
                    label="Dynamic column scaling"
                    hint="Columns grow proportionally to their issue count, giving more space to busy columns."
                  />
                </div>
                </>
  );
}
