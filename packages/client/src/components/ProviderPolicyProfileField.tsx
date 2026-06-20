import { useEffect, useState } from "react";

export const CUSTOM_PROFILE_SENTINEL = "__custom__";

/**
 * Profile picker for a provider policy: a dropdown of the real profiles
 * available for the policy's provider, with a "Custom…" escape hatch that
 * reveals a free-text input. Keeps any pre-existing custom value selectable
 * even if it is no longer reported by the profile endpoints (AK-836).
 */
export function ProviderPolicyProfileField({
  provider,
  profileName,
  availableProfiles,
  onChange,
}: {
  provider: "claude" | "codex" | "copilot" | "pi";
  profileName: string;
  availableProfiles: string[];
  onChange: (name: string) => void;
}) {
  const known = profileName === "" || availableProfiles.includes(profileName);
  const [custom, setCustom] = useState(!known);

  // When the provider changes the profile may no longer be in the list; only
  // force custom mode for a non-empty value that isn't selectable.
  useEffect(() => {
    if (profileName && !availableProfiles.includes(profileName)) setCustom(true);
  }, [provider, profileName, availableProfiles]);

  const useCustom = custom || !known;
  const selectClass = "w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";

  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-gray-500 dark:text-gray-400">Profile</span>
      {useCustom ? (
        <div className="flex items-center gap-1">
          <input
            value={profileName}
            onChange={(event) => onChange(event.target.value)}
            placeholder="default"
            className={selectClass}
          />
          {availableProfiles.length > 0 && (
            <button
              type="button"
              onClick={() => { setCustom(false); onChange(availableProfiles[0] ?? ""); }}
              className="shrink-0 rounded px-1.5 py-1 text-[10px] text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              title="Pick from available profiles"
            >
              List
            </button>
          )}
        </div>
      ) : (
        <select
          value={profileName}
          onChange={(event) => {
            if (event.target.value === CUSTOM_PROFILE_SENTINEL) { setCustom(true); return; }
            onChange(event.target.value);
          }}
          className={selectClass}
        >
          <option value="">default</option>
          {availableProfiles.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
          <option value={CUSTOM_PROFILE_SENTINEL}>Custom…</option>
        </select>
      )}
    </label>
  );
}
