/**
 * A plugin's scaffold file — extracted from `plugin.service.ts` to keep it under the 1000-line
 * god-module ceiling. That ceiling is part of `verify_script`, so when it trips it fails the
 * pre-merge gate for EVERY workspace on the board, not only the branch that grew the file.
 *
 * All three functions already took everything they needed as arguments, so this is a pure lift:
 * no service closure, no database, no plugin registry.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  countScaffoldPlaceholders,
  substitutePluginPlaceholders,
  type PluginManifest,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import type { PluginRow } from "../repositories/plugins.repository.js";
import { PluginError } from "./plugin-errors.js";
import { resolveInside } from "./plugin-fs.js";

/** The subset of EnableReport the scaffold fan-out writes into. */
export interface ScaffoldReportSink {
  scaffoldWritten: boolean;
  scaffoldPlaceholders: number;
  warnings: string[];
}

type PluginWithManifest = PluginRow & { manifest: PluginManifest };

/**
 * Write the plugin's scaffold template into the target repo, substituting placeholders.
 * No-op when the plugin declares no scaffold or the target already exists (never clobbers a
 * file the human may have filled in).
 */
export function fanOutScaffold(
  plugin: PluginWithManifest,
  repoPath: string,
  leadingRepoPath: string,
  projectName: string,
  report: ScaffoldReportSink,
): void {
  const scaffold = plugin.manifest.scaffold;
  if (!scaffold) return;
  const target = resolveInside(repoPath, scaffold.targetPath, `scaffold targetPath "${scaffold.targetPath}"`);
  if (existsSync(target)) return;
  const templatePath = resolveInside(plugin.localPath, scaffold.profileTemplate, "scaffold profileTemplate");
  if (!existsSync(templatePath)) {
    report.warnings.push(`scaffold template not found in plugin: ${scaffold.profileTemplate}`);
    return;
  }
  const content = substitutePluginPlaceholders(readFileSync(templatePath, "utf8"), {
    repoPath,
    leadingRepoPath,
    projectName,
    pluginPath: plugin.localPath,
  });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  report.scaffoldWritten = true;
  report.scaffoldPlaceholders = countScaffoldPlaceholders(content);
  if (report.scaffoldPlaceholders > 0) {
    report.warnings.push(
      `scaffold written — ${report.scaffoldPlaceholders} placeholder${report.scaffoldPlaceholders === 1 ? "" : "s"} `
      + `need filling in ${scaffold.targetPath} before this plugin's scripts/loops will run`,
    );
  }
}

/**
 * Live readiness of a plugin's scaffold file (not the write-time snapshot in
 * `EnableReport` — the human may fill it in any time after enable). Returns
 * `null` when the plugin declares no scaffold, or the file doesn't exist yet
 * (nothing to gate on until it's written).
 */
export function scaffoldPlaceholderStatus(
  plugin: PluginWithManifest,
  repoPath: string,
): { targetPath: string; remaining: number } | null {
  const scaffold = plugin.manifest.scaffold;
  if (!scaffold) return null;
  const target = resolveInside(repoPath, scaffold.targetPath, `scaffold targetPath "${scaffold.targetPath}"`);
  if (!existsSync(target)) return null;
  return { targetPath: scaffold.targetPath, remaining: countScaffoldPlaceholders(readFileSync(target, "utf8")) };
}

/** One unresolved `TODO:` marker, addressable by its occurrence index (#291). */
export interface ScaffoldField {
  /** 0-based occurrence index among the file's REAL (non-code-span) `TODO:` markers. */
  index: number;
  /** The text after `TODO:` on that line — the field's label/hint for the form. */
  label: string;
  /** The full line, for context in the form UI. */
  line: string;
}

/**
 * Strip inline-code spans the same way `countScaffoldPlaceholders` does, so the
 * form's field count and the gate's placeholder count can never disagree about
 * which markers are real.
 */
function maskCodeSpans(content: string): string {
  // Replace span CONTENT with spaces of equal length — offsets must survive.
  return content.replace(/`[^`\n]*`/g, (m) => "`".padEnd(m.length - 1, " ") + "`");
}

/** Parse the scaffold's unresolved TODO markers into form fields (#291). */
export function parseScaffoldFields(content: string): ScaffoldField[] {
  const masked = maskCodeSpans(content);
  const fields: ScaffoldField[] = [];
  const re = /TODO:/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = re.exec(masked)) !== null) {
    const lineStart = masked.lastIndexOf("\n", match.index) + 1;
    const lineEndRaw = masked.indexOf("\n", match.index);
    const lineEnd = lineEndRaw === -1 ? masked.length : lineEndRaw;
    // Read label/line from the ORIGINAL content at the same offsets — the mask
    // only hides code spans from the scan, it must not leak into the UI.
    fields.push({
      index,
      label: content.slice(match.index + "TODO:".length, lineEnd).trim(),
      line: content.slice(lineStart, lineEnd).trim(),
    });
    index++;
  }
  return fields;
}

/**
 * Replace TODO markers with human-supplied values, by occurrence index (#291).
 * Each value replaces `TODO:` and the rest of that line's marker text (the
 * label is a hint, not content). Unaddressed markers stay. Returns the new
 * content and how many markers remain.
 */
export function applyScaffoldValues(
  content: string,
  values: Array<{ index: number; value: string }>,
): { content: string; remaining: number } {
  const byIndex = new Map(values.filter((v) => v.value.trim()).map((v) => [v.index, v.value.trim()]));
  const masked = maskCodeSpans(content);
  const re = /TODO:/g;
  let match: RegExpExecArray | null;
  let index = 0;
  // Collect replacements as [start, end, text] against the ORIGINAL content, then apply
  // back-to-front so earlier offsets stay valid.
  const edits: Array<{ start: number; end: number; text: string }> = [];
  while ((match = re.exec(masked)) !== null) {
    const value = byIndex.get(index);
    if (value !== undefined) {
      const lineEndRaw = masked.indexOf("\n", match.index);
      const lineEnd = lineEndRaw === -1 ? masked.length : lineEndRaw;
      edits.push({ start: match.index, end: lineEnd, text: value });
    }
    index++;
  }
  let out = content;
  for (const edit of edits.reverse()) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return { content: out, remaining: countScaffoldPlaceholders(out) };
}

/** Throws a clear, actionable error instead of letting a script/loop fail on unfilled scaffold TODOs. */
export function requireScaffoldReady(
  plugin: PluginWithManifest,
  repoPath: string,
  action: "scripts" | "loops",
): void {
  const status = scaffoldPlaceholderStatus(plugin, repoPath);
  if (!status || status.remaining === 0) return;
  throw new PluginError(
    `Scaffold "${status.targetPath}" still has ${status.remaining} unresolved TODO: placeholder${status.remaining === 1 ? "" : "s"} `
    + `— fill them in before running this plugin's ${action}.`,
    "CONFLICT",
  );
}
