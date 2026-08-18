import { useEffect, useMemo, useState } from "react";
import { MarkdownView } from "./MarkdownView.js";
import { apiFetch, apiPost, apiPut } from "../lib/api.js";
import { showToast } from "./Toast.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * The scaffold's unresolved `TODO:` markers as a form (#291). The scaffold gate
 * (which blocks every script and loop until the markers are gone) used to be
 * resolvable only by opening the markdown file in an editor — for a PO-facing
 * plugin that is the very first touchpoint, and it assumed repo knowledge.
 * Submitting writes the values into the file in place; the plugin remains the
 * owner of the file's format.
 */

export type ScaffoldForm = {
  /** `null` when the plugin declares no scaffold at all (#658) — a valid answer, not an error. */
  targetPath: string | null;
  exists: boolean;
  content: string | null;
  fields: Array<{ index: number; label: string; line: string }>;
};

export type ProductIdentity = {
  /** The product's name, if the profile states one. */
  name: string | null;
  /** The one-line pitch, if the profile states one. */
  pitch: string | null;
  /** `name: pitch` when both are known, otherwise whichever exists. */
  oneLiner: string;
};

const NAME_LABELS = ["name", "product name", "product"];
const PITCH_LABELS = ["one-line pitch", "one line pitch", "pitch", "one-liner", "tagline"];

function labelledValue(content: string, labels: string[]): string | null {
  for (const rawLine of content.split(/\r?\n/)) {
    // `- **One-line pitch:** …`, `**Name**: …`, `* Product: …` — the scaffold's own
    // shape, but tolerant of the variants a human editing the file by hand produces.
    const m = /^\s*(?:[-*+]\s*)?\*{0,2}([^*:]{1,40}?)\*{0,2}\s*:\s*\*{0,2}\s*(.+?)\s*\*{0,2}\s*$/.exec(rawLine);
    if (!m) continue;
    const label = m[1].trim().toLowerCase();
    if (!labels.includes(label)) continue;
    const value = m[2].replace(/^\*+|\*+$/g, "").trim();
    // A `TODO:` placeholder is not an answer — treat it as absent (#291 gate semantics).
    if (!value || /^todo\b/i.test(value)) continue;
    return value;
  }
  return null;
}

/**
 * The product one-liner, derived from the scaffold profile markdown (#455).
 *
 * The profile is the only place the product is described, so other panes (e.g. the
 * loop header, where a reviewer approving "step 7 of a pipeline for *what*" spends
 * their time) need this same derivation. Exported so they can reuse it rather than
 * re-parse the file. Returns null when the profile names neither — better nothing
 * than a confidently wrong identity.
 */
export function deriveProductIdentity(content: string | null | undefined): ProductIdentity | null {
  if (!content) return null;
  const name = labelledValue(content, NAME_LABELS);
  const pitch = labelledValue(content, PITCH_LABELS);
  if (!name && !pitch) return null;
  return { name, pitch, oneLiner: name && pitch ? `${name}: ${pitch}` : (pitch ?? name ?? "") };
}

export function PluginScaffoldPane({ pluginId, pluginName, projectId, onFilled }: {
  pluginId: string;
  pluginName: string;
  projectId: string;
  onFilled: () => void;
}) {
  const [form, setForm] = useState<ScaffoldForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [showFile, setShowFile] = useState(false);
  // #438: a COMPLETE profile has no TODO markers, so the index-addressed form above
  // can no longer reach any of it. `draft` is the whole-file editor that makes a
  // wrong answer correctable — null while not editing.
  const [draft, setDraft] = useState<string | null>(null);

  async function load() {
    try {
      const res = await apiFetch<ScaffoldForm>(`/api/plugins/${pluginId}/scaffold?projectId=${projectId}`);
      setForm(res);
      setError(null);
      setValues({});
      setDraft(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pluginId, projectId]);

  async function submit() {
    if (!form || saving) return;
    const entries = Object.entries(values)
      .map(([index, value]) => ({ index: Number(index), value }))
      .filter((v) => v.value.trim());
    if (entries.length === 0) {
      showToast("Fill in at least one field", "error");
      return;
    }
    setSaving(true);
    try {
      const res = await apiPost<{ remaining: number }>(`/api/plugins/${pluginId}/scaffold`, {
        projectId,
        values: entries,
      });
      showToast(
        res.remaining === 0
          ? "Profile complete — scripts and loops are unblocked"
          : `Saved — ${res.remaining} field(s) still open`,
        "success",
      );
      await load();
      onFilled();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Saving the profile failed", "error");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Save the whole file (#438). The plugin owns the format, so this deliberately
   * writes back exactly what the human typed rather than reformatting it — the same
   * contract the per-field form honours.
   */
  async function saveDraft() {
    if (draft === null || saving) return;
    setSaving(true);
    try {
      const res = await apiPut<{ remaining: number; committed: boolean }>(
        `/api/plugins/${pluginId}/scaffold`,
        { projectId, content: draft },
      );
      showToast(
        res.remaining > 0
          ? `Saved — ${res.remaining} TODO marker(s) now open, which re-blocks scripts and loops`
          : res.committed
            ? "Profile saved and committed — step agents will see it"
            : "Profile saved (not committed — no git repo)",
        res.remaining > 0 ? "error" : "success",
      );
      await load();
      onFilled();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Saving the profile failed", "error");
    } finally {
      setSaving(false);
    }
  }

  // #455: once the profile is complete this pane stops being a setup form. It is then the
  // only place the product is described, so it renders as a product overview instead of an
  // empty screen with the profile hidden behind a collapsed "Preview the file".
  const complete = Boolean(form?.exists) && form?.fields.length === 0;
  const overview = complete && draft === null;
  const identity = useMemo(() => deriveProductIdentity(form?.content), [form?.content]);

  return (
    <div className="p-6 space-y-4 overflow-y-auto" data-testid="plugin-scaffold-pane">
      {overview ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <h2 className="text-base font-medium text-gray-900 dark:text-gray-100">
              {identity?.name ?? `${pluginName} — project profile`}
            </h2>
            {identity?.pitch && (
              <p className="text-xs text-gray-600 dark:text-gray-300 max-w-2xl" data-testid="plugin-scaffold-pitch">
                {identity.pitch}
              </p>
            )}
            <p className="text-[11px] text-gray-500 dark:text-gray-400 max-w-2xl">
              The scope contract every step agent reads first —{" "}
              <span className="font-mono">{form?.targetPath}</span>.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-green-700 dark:text-green-400" data-testid="plugin-scaffold-complete">
              ✓ Profile complete
            </span>
            {/* #438: without this the profile was write-once. Every step agent reads it
                first, so a wrong answer here quietly skews all of them. */}
            <button
              onClick={() => setDraft(form?.content ?? "")}
              className="text-xs px-3 py-2 sm:py-1 min-h-11 sm:min-h-0 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300"
              data-testid="plugin-scaffold-edit"
            >
              Edit profile
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          <h2 className="text-base font-medium text-gray-900 dark:text-gray-100">Set up {pluginName}</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 max-w-2xl">
            This plugin scaffolded a profile file into the project
            {form && <> (<span className="font-mono">{form.targetPath}</span>)</>} and blocks its scripts and
            loops until every marker below is filled in — the profile is the scope contract the plugin&apos;s
            agents work from. Answer here, or edit the file directly; both write the same place.
          </p>
        </div>
      )}

      {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
      {form && !form.exists && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          The scaffold file has not been written yet — enable the plugin for this project first.
        </p>
      )}
      {overview && form?.content && (
        // Rendered inline, not behind a disclosure: this IS the pane's content once setup
        // is done. Same prose handling as ArtifactViewer so wide tables/code stay readable.
        <div
          // Heading scale capped: the profile's own `# PM Pipeline — Project Profile` at the
          // default prose h1 size dwarfs this pane's header and re-titles the screen.
          className="prose prose-sm dark:prose-invert max-w-none prose-pre:whitespace-pre-wrap prose-pre:break-words prose-img:max-w-full prose-h1:text-base prose-h2:text-sm prose-h3:text-sm"
          data-testid="plugin-scaffold-profile"
        >
          <MarkdownView>{form.content}</MarkdownView>
        </div>
      )}

      {form?.exists && form.fields.length > 0 && (
        <div className="space-y-3 max-w-2xl">
          {form.fields.map((field) => (
            <label key={field.index} className="block space-y-1">
              <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
                {field.label || `Field ${field.index + 1}`}
              </span>
              <span className="block text-[11px] font-mono text-gray-400 dark:text-gray-500 truncate" title={field.line}>
                {field.line}
              </span>
              <textarea
                value={values[field.index] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [field.index]: e.target.value }))}
                rows={2}
                disabled={saving}
                // text-base below sm: iOS Safari zooms the page for inputs under 16px and does
                // not zoom back, which on an 11-field form leaves you panned off-screen (#434).
                className="w-full text-base sm:text-sm px-2 py-2 sm:py-1.5 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 disabled:opacity-50"
                data-testid={`plugin-scaffold-field-${field.index}`}
              />
            </label>
          ))}
          <button
            onClick={() => void submit()}
            disabled={saving}
            className="text-sm px-4 py-2.5 sm:px-3 sm:py-1.5 min-h-11 sm:min-h-0 w-full sm:w-auto rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
            data-testid="plugin-scaffold-save"
          >
            {saving ? "Saving…" : "Save profile"}
          </button>
        </div>
      )}

      {draft !== null && (
        <div className="space-y-2 max-w-2xl" data-testid="plugin-scaffold-editor">
          <p className="text-[11px] text-gray-500 dark:text-gray-400">
            Editing <span className="font-mono">{form?.targetPath}</span>. Saving commits the file
            — step agents run in worktrees and only see committed changes. Re-introducing a{" "}
            <span className="font-mono">TODO:</span> marker will block this plugin&apos;s scripts and loops again.
          </p>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={20}
            disabled={saving}
            spellCheck={false}
            // text-base below sm for the same iOS zoom reason as the field form (#434) —
            // correcting the profile from a phone is the point of this editor.
            className="w-full font-mono text-base sm:text-xs px-2 py-2 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 disabled:opacity-50"
            data-testid="plugin-scaffold-textarea"
          />
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void saveDraft()}
              disabled={saving || draft.trim() === ""}
              className="text-sm px-4 py-2.5 sm:px-3 sm:py-1.5 min-h-11 sm:min-h-0 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
              data-testid="plugin-scaffold-draft-save"
            >
              {saving ? "Saving…" : "Save profile"}
            </button>
            <button
              onClick={() => setDraft(null)}
              disabled={saving}
              className="text-sm px-4 py-2.5 sm:px-3 sm:py-1.5 min-h-11 sm:min-h-0 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300 disabled:opacity-50"
              data-testid="plugin-scaffold-draft-cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Setup state only (#455): when the profile is complete it is rendered inline above,
          so a collapsed copy of the same file would just be a second, worse view of it. */}
      {form?.exists && form.content && draft === null && !complete && (
        <div className="max-w-2xl">
          <button
            onClick={() => setShowFile((s) => !s)}
            className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
          >
            {showFile ? "▾" : "▸"} Preview the file
          </button>
          {showFile && (
            <pre className="mt-2 p-3 rounded bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 overflow-auto whitespace-pre-wrap break-all text-[11px] text-gray-700 dark:text-gray-300 max-h-80">
              {form.content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
