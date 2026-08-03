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
