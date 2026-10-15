import type { Command } from "commander";

/** #1496: default verify slots from this machine - one per ~16 GB total RAM and ~4 cores (a full test:mine uses ~4 workers), 1..3. */
export function deriveVerifySlots(totalRamGb: number, cores: number): number {
  return Math.max(1, Math.min(3, Math.floor(totalRamGb / 16), Math.floor(cores / 4)));
}

/** The explicit `--verify-slots` / config value when positive, else the machine-derived default. */
export function resolveVerifySlots(explicit: number | undefined, totalRamGb: number, cores: number): number {
  return explicit && explicit > 0 ? explicit : deriveVerifySlots(totalRamGb, cores);
}

export interface VerifySlotsStartOption { verifySlots?: number }

export function addVerifySlotsOption(cmd: Command): Command {
  return cmd.option("--verify-slots <n>", "Concurrent pre-merge gates/sweeps this worker runs (#1496; default derived from RAM and cores, 1-3)", (v) => parseInt(v, 10));
}
