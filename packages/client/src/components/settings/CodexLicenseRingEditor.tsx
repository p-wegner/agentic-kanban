import { type Settings, type SettingsTextSetter } from "../SettingsPanel.shared.js";
import { ProviderRotationRingEditor, type RingEditorConfig } from "./ProviderRotationRingEditor.js";

/**
 * Editor for Codex licenses + the rotation ring. Auto-discovered `~/.codex-<name>`
 * logins show up here (with login status) even when they aren't in the rotation ring,
 * because they are already first-class selectable profiles. The "In rotation" checkbox
 * is what adds a license to the `codex_license_ring` pref (order + cooldown rotation).
 * OAuth rows get Login (opens a real terminal `codex login`) and Copy buttons. Mirrors
 * ClaudeSubscriptionRingEditor; both render through ProviderRotationRingEditor.
 */
const CODEX_RING_CONFIG: RingEditorConfig = {
  ringSettingKey: "codex_license_ring",
  rotationSettingKey: "codex_license_rotation",
  discoverEndpoint: "/api/preferences/codex-licenses",
  discoverResponseKey: "licenses",
  loginEndpoint: "/api/preferences/codex-login",
  loginBodyKey: "codexHome",
  dirField: "codexHome",
  apiKeyField: "configToml",
  dirPrefix: ".codex-",
  envVar: "CODEX_HOME",
  loginInvocation: "codex login",
  noun: "license",
  fieldLabel: "Codex Licenses",
  hint: "Any logged-in ~/.codex-<name> is auto-discovered and selectable as a Codex profile (Agent Profile dropdown + New Workspace), exactly like a toml profile. Add a row for a new OAuth login (the CODEX_HOME path is inferred from the name) and click Login. Check 'In rotation' to include a license in the rotation ring — the board falls over to the next one when a license hits its usage limit. API key = a config_<name>.toml in ~/.codex.",
  authFileLabel: "auth.json",
  profileExample: "ki14",
  apiKeyOptionLabel: "API key (config toml)",
  apiKeyPlaceholder: "config_apikey1",
};

export function CodexLicenseRingEditor({ settings, set }: { settings: Settings; set: SettingsTextSetter }) {
  return <ProviderRotationRingEditor config={CODEX_RING_CONFIG} settings={settings} set={set} />;
}
