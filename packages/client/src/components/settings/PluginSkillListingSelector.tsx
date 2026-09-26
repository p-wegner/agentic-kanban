import { useState } from "react";
import type { SkillListing } from "@agentic-kanban/shared";
import { SKILL_LISTINGS } from "@agentic-kanban/shared";
import { apiPost } from "../../lib/api.js";
import { showToast } from "../../lib/toast.js";

/** One skill's resolved listing (mode + where it came from) — from GET /api/plugins?projectId=. */
export type ResolvedSkillListing = {
  name: string;
  mode: SkillListing;
  source: "project" | "manifest" | "default";
  manifestHint: SkillListing | undefined;
  descriptionSize: number;
};

const LISTING_MODE_LABELS: Record<SkillListing, string> = {
  on: "On (full description)",
  "name-only": "Name only",
  "user-invocable-only": "User-invocable only",
  off: "Off",
};

const LISTING_SOURCE_LABELS: Record<ResolvedSkillListing["source"], string> = {
  project: "this project",
  manifest: "plugin's manifest hint",
  default: "board default",
};

type PluginSkillListingSelectorProps = {
  pluginId: string;
  activeProjectId: string;
  listings: ResolvedSkillListing[];
  onChange: (skillName: string, mode: SkillListing) => void;
};

/**
 * Settings → Plugins → one plugin's per-skill listing picker (#1252) — extracted out of
 * `PluginsSettings` (function-nloc ratchet) so the parent stays a plain list renderer. Owns
 * the save-in-flight state and the `POST .../skills/:name/listing` call; the parent supplies
 * the resolved listings and is told the outcome via `onChange` so it can update its own rows.
 */
export function PluginSkillListingSelector({ pluginId, activeProjectId, listings, onChange }: PluginSkillListingSelectorProps) {
  const [changingListingKey, setChangingListingKey] = useState<string | null>(null);

  async function handleChangeSkillListing(skillName: string, mode: SkillListing) {
    const key = `${pluginId}:${skillName}`;
    if (changingListingKey) return;
    setChangingListingKey(key);
    try {
      await apiPost(`/api/plugins/${pluginId}/skills/${encodeURIComponent(skillName)}/listing`, {
        projectId: activeProjectId,
        mode,
      });
      onChange(skillName, mode);
      showToast(`"${skillName}" listing set to "${LISTING_MODE_LABELS[mode]}"`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to change skill listing", "error");
    } finally {
      setChangingListingKey(null);
    }
  }

  return (
    <div className="space-y-1.5">
      {listings.map((listing) => {
        const listingKey = `${pluginId}:${listing.name}`;
        return (
          <div key={listing.name} className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">
              {listing.name}
            </span>
            <select
              value={listing.mode}
              onChange={(e) => void handleChangeSkillListing(listing.name, e.target.value as SkillListing)}
              disabled={changingListingKey === listingKey}
              className="text-xs border border-gray-300 dark:border-gray-600 rounded px-1.5 py-0.5 dark:bg-gray-800 dark:text-gray-200 disabled:opacity-50"
              data-testid={`plugin-skill-listing-${pluginId}-${listing.name}`}
            >
              {SKILL_LISTINGS.map((mode) => (
                <option key={mode} value={mode}>{LISTING_MODE_LABELS[mode]}</option>
              ))}
            </select>
            <span className="text-[11px] text-gray-400 dark:text-gray-500">
              from {LISTING_SOURCE_LABELS[listing.source]} · ~{listing.descriptionSize} chars/turn when on
            </span>
            {changingListingKey === listingKey && <span className="text-[11px] text-gray-400">Saving…</span>}
          </div>
        );
      })}
    </div>
  );
}
