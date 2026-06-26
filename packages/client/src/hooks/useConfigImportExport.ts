import { useState } from "react";
import { apiFetch } from "../lib/api.js";
import { showToast } from "../lib/toast.js";

interface ConfigChangePreview {
  statusChanges: { toAdd: unknown[]; toUpdate: unknown[] };
  prefChanges: Record<string, { from: string | undefined; to: string }>;
  strategyChanged: boolean;
}

export type ConfigImportPreview = ConfigChangePreview & { pendingFile: File };

/** Owns the project config export / import (dry-run preview → confirm) flow for
 *  the Settings → Project tab. Self-contained: its only input is the active
 *  project id; it manages its own in-flight + preview state. Extracted verbatim
 *  from SettingsPanel. */
export function useConfigImportExport(activeProjectId: string | null | undefined) {
  const [configExporting, setConfigExporting] = useState(false);
  const [configImporting, setConfigImporting] = useState(false);
  const [configImportPreview, setConfigImportPreview] = useState<ConfigImportPreview | null>(null);

  async function handleConfigExport() {
    if (!activeProjectId || configExporting) return;
    setConfigExporting(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- binary download: response is a blob, not a JSON read for the query layer
      const resp = await fetch(`/api/projects/${activeProjectId}/config/export`);
      if (!resp.ok) throw new Error(`Export failed: ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `board-config-${activeProjectId}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("Config exported", "success");
    } catch {
      showToast("Export failed", "error");
    } finally {
      setConfigExporting(false);
    }
  }

  async function handleConfigImportFile(file: File) {
    if (!activeProjectId || configImporting) return;
    setConfigImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const preview = await apiFetch<ConfigChangePreview>(`/api/projects/${activeProjectId}/config/import?dryRun=true`, {
        method: "POST",
        body: formData,
      });
      setConfigImportPreview({ ...preview, pendingFile: file });
    } catch {
      showToast("Could not parse config file", "error");
    } finally {
      setConfigImporting(false);
    }
  }

  async function handleConfigImportConfirm() {
    if (!activeProjectId || !configImportPreview) return;
    setConfigImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", configImportPreview.pendingFile);
      await apiFetch(`/api/projects/${activeProjectId}/config/import`, {
        method: "POST",
        body: formData,
      });
      setConfigImportPreview(null);
      showToast("Config imported successfully", "success");
    } catch {
      showToast("Import failed", "error");
    } finally {
      setConfigImporting(false);
    }
  }

  return {
    configExporting,
    configImporting,
    configImportPreview,
    setConfigImportPreview,
    handleConfigExport,
    handleConfigImportFile,
    handleConfigImportConfirm,
  };
}
