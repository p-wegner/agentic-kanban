import { type Settings, type SettingsTextSetter } from "../SettingsPanel.shared.js";
import { ProviderRotationRingEditor, type RingEditorConfig } from "./ProviderRotationRingEditor.js";

/**
 * Editor for Claude subscriptions + the rotation ring. Auto-discovered `~/.claude-<name>`
 * logins show up here (with login status) even when they aren't in the rotation ring,
 * because they are already first-class selectable profiles. The "In rotation" checkbox
 * is what adds a subscription to the `claude_subscription_ring` pref (order + cooldown
 * rotation). OAuth rows get Login (opens a real terminal `claude /login`) and Copy
 * buttons. Mirrors CodexLicenseRingEditor — a Claude subscription is a CLAUDE_CONFIG_DIR
 * dir (with its own OAuth login), exactly as a Codex license is a CODEX_HOME dir; both
 * render through ProviderRotationRingEditor.
 */
const CLAUDE_RING_CONFIG: RingEditorConfig = {
  ringSettingKey: "claude_subscription_ring",
  rotationSettingKey: "claude_subscription_rotation",
  discoverEndpoint: "/api/preferences/claude-subscriptions",
  discoverResponseKey: "subscriptions",
  loginEndpoint: "/api/preferences/claude-login",
  loginBodyKey: "configDir",
  dirField: "configDir",
  apiKeyField: "settingsProfile",
  dirPrefix: ".claude-",
  envVar: "CLAUDE_CONFIG_DIR",
  loginInvocation: "claude /login",
  noun: "subscription",
  fieldLabel: "Claude Subscriptions",
  hint: "Any logged-in ~/.claude-<name> is auto-discovered and selectable as a Claude profile (Agent Profile dropdown + New Workspace), exactly like a settings_*.json profile. Add a row for a new OAuth login (the CLAUDE_CONFIG_DIR path is inferred from the name) and click Login. Check 'In rotation' to include a subscription in the rotation ring — the board falls over to the next one when a subscription (Max/Pro plan) hits its usage limit. API key = a settings_<name>.json in ~/.claude.",
  authFileLabel: ".credentials.json",
  profileExample: "max2",
  apiKeyOptionLabel: "API key (settings json)",
  apiKeyPlaceholder: "settings profile name",
};

export function ClaudeSubscriptionRingEditor({ settings, set }: { settings: Settings; set: SettingsTextSetter }) {
  return <ProviderRotationRingEditor config={CLAUDE_RING_CONFIG} settings={settings} set={set} />;
}
