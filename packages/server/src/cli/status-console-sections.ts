import { formatAge, formatElapsed, type ConsoleModel, type ConsoleTrain } from "./status-console-model.js";
import type { ConsoleChain } from "./status-console-extras.js";

// `status --watch` sections added by #1449 (verify chains, base/release state, connect codes),
// plus the line/section types the renderer and these sections share. Pure, like the renderer.

export type Tone = "red" | "yellow" | "green" | "cyan" | "dim" | "head" | null;
/** `raw` lines are already truncated and painted (a joined two-column row). */
export interface Line { text: string; tone: Tone; raw?: boolean }
export interface Section { id: string; lines: Line[]; keep?: boolean }
export interface Glyphs { a: boolean; ell: string; dot: string; sq: [string, string]; rule: string; nowMs: number }

export const heading = (name: string): Line => ({ text: name, tone: "head" });
export const issueRef = (n: number | null) => (n != null ? `#${n}` : "#?");
export function since(iso: string | null, nowMs: number): string {
  return iso ? formatElapsed(nowMs - new Date(iso).getTime()) : "-";
}
export const isLive = (t: ConsoleTrain) => !t.finishedAt && ["assembling", "gating", "landing"].includes(t.state);

function chainLine(c: ConsoleChain, g: Glyphs): Line {
  const what = `${c.kind} ${c.ref}`.trim();
  if (c.state === "running") {
    // Elapsed leads the progress so a narrow column truncates the stage text, never the clock (#1462).
    const files = c.filesTotal && (c.filesDone ?? 0) <= c.filesTotal ? ` ${c.filesDone ?? 0}/${c.filesTotal}` : c.filesDone ? ` ${c.filesDone}` : "";
    const elapsed = c.ageMs > 0 ? formatElapsed(c.ageMs).padStart(6) : "";
    return { text: ` ${g.a ? ">" : "▶"} ${what.padEnd(22)} ${c.where.padEnd(8)} ${elapsed}${c.stage ? `  ${c.stage}` : ""}${files}`, tone: "cyan" };
  }
  return { text: ` ${g.a ? "|" : "⏸"} #${c.position ?? "?"} ${what.padEnd(25)} ${c.where.padEnd(10)} waiting ${formatElapsed(c.ageMs)}${c.waitReason ? `: ${c.waitReason}` : ""}`, tone: "yellow" };
}

export function gatesSection(model: ConsoleModel, g: Glyphs): Section | null {
  const live = model.trains.filter(isLive);
  const chains = model.chains ?? [];
  const queued = model.host?.verifyQueued ?? 0;
  if (live.length === 0 && chains.length === 0 && queued === 0) return null;
  const lines: Line[] = [heading("GATES & TESTS")];
  for (const t of live) {
    lines.push({ text: ` ${g.a ? ">" : "▶"} ${t.label.padEnd(12)} ${t.state.padEnd(10)} ${t.members} members · gate run ${t.gateRuns}  ${since(t.startedAt, g.nowMs)}`, tone: "cyan" });
    if (t.shepherd) lines.push({ text: `   ${t.shepherd}`, tone: "dim" });
  }
  for (const c of chains) lines.push(chainLine(c, g));
  if (chains.length === 0 && queued > 0) lines.push({ text: ` ${g.a ? "|" : "⏸"} ${queued} verify chain(s) queued behind ${model.host?.verifyActive ?? 0} running`, tone: "yellow" });
  return { id: "gates", lines };
}

/** Master's verdict, the merge-window hold, the rc and the stable tag, and where gates may run. */
export function baseReleaseSection(model: ConsoleModel, g: Glyphs): Section | null {
  const lines: Line[] = [heading("BASE & RELEASE")];
  const b = model.baseHealth;
  if (b) {
    const red = b.outcome === "red";
    const suites = red && b.failedSuites.length > 0 ? `: ${b.failedSuites.slice(0, 2).join(", ")}${b.failedSuites.length > 2 ? ` +${b.failedSuites.length - 2}` : ""}` : "";
    lines.push({ text: ` master ${b.outcome} ${b.sha.slice(0, 8)} ${formatAge(g.nowMs - new Date(b.createdAt).getTime())} ago${suites}`, tone: red ? "red" : b.outcome === "green" ? "green" : "yellow" });
  }
  const h = model.mergeHold;
  if (h) lines.push({ text: ` merges held: ${h.reason}${h.held.length ? ` · holding ${h.held.map(issueRef).join(" ")}` : ""}`, tone: h.reason === "base_red" || h.reason === "breaker_paused" ? "red" : "dim" });
  const rc = model.rc;
  // #1631: a rolling rc is swept on idle, so the line says what a promote would find — `sweeping 9m (full)` / `green, promotable`.
  if (rc) lines.push({ text: ` rc ${rc.branch} ${rc.sha ? rc.sha.slice(0, 7) : "-"} ${rc.state === "green" ? "green, promotable" : rc.state}${rc.updatedAt ? ` ${since(rc.updatedAt, g.nowMs)}` : ""}${rc.state === "sweeping" ? " (full)" : ""}`, tone: rc.state === "red" ? "red" : rc.state === "sweeping" || rc.state === "cut" ? "cyan" : null });
  if (model.boardTag || model.unpromoted != null) {
    lines.push({ text: ` stable ${model.boardTag ?? "-"}${model.unpromoted != null ? ` · ${model.unpromoted} merge${model.unpromoted === 1 ? "" : "s"} not yet promoted` : ""}`, tone: model.unpromoted ? "yellow" : null });
  }
  if (model.codeHealth) lines.push({ text: ` ${model.codeHealth}`, tone: "dim" });
  const p = model.placement;
  if (p) lines.push({ text: ` verify placement ${p.mode}${p.workers.length ? ` · allow ${p.workers.join(", ")}` : p.mode === "host" ? "" : " · allowlist empty (gates stay on host)"}`, tone: null });
  return lines.length > 1 ? { id: "base", lines, keep: true } : null;
}

/** #1442: one-time connect codes still live, with the steps the new worker has reported. */
export function connectSection(model: ConsoleModel, g: Glyphs): Section | null {
  const codes = model.connectCodes ?? [];
  if (codes.length === 0) return null;
  const lines: Line[] = [heading("NEW WORKER CONNECTIONS")];
  for (const c of codes) {
    const steps = c.steps.map((s) => `${s.status === "ok" ? (g.a ? "ok" : "✔") : (g.a ? "X" : "✖")} ${s.step}`).join(" ");
    lines.push({ text: ` code ${c.codeHint} ${c.status}${steps ? ` · ${steps}` : " · waiting for the first step"}`, tone: c.steps.some((s) => s.status !== "ok") ? "red" : "cyan" });
  }
  return { id: "connect", lines };
}

/** #1673: one line per project with an enabled sync plugin; absent for projects without one. */
export function syncSection(model: ConsoleModel): Section | null {
  const lines = model.syncLines ?? [];
  if (lines.length === 0) return null;
  return { id: "sync", lines: [heading("SYNC"), ...lines.map((l): Line => ({ text: ` ${l.text}`, tone: l.level === "red" ? "red" : l.level === "yellow" ? "yellow" : null }))] };
}
