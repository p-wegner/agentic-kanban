// @covers workspaces.setupIoFault [recovery, boundary]
//
// #1125 — classifying the recorded `ERR_PNPM_UNKNOWN` / errno -4094 signature and repairing
// the one corrupted, content-addressed pnpm-store file it names.
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifySetupFailure, describeSetupFailure, repairIoFault } from "../services/setup-io-fault.js";

const SAMPLE_OUTPUT = (storePath: string) =>
  `ERR_PNPM_UNKNOWN  UNKNOWN: unknown error, stat '${storePath}'`;

describe("classifySetupFailure (#1125)", () => {
  it("classifies the recorded ERR_PNPM_UNKNOWN / errno -4094 signature as an io-fault", () => {
    const result = classifySetupFailure({
      stdout: SAMPLE_OUTPUT("C:\\Users\\pwegner\\.pnpm-store\\v10\\files\\42\\a81d86"),
    });
    expect(result.kind).toBe("io-fault");
  });

  it("extracts the offending pnpm-store path from the syscall error", () => {
    const result = classifySetupFailure({
      stdout: SAMPLE_OUTPUT("C:\\Users\\pwegner\\.pnpm-store\\v10\\files\\42\\a81d86"),
    });
    expect(result.kind).toBe("io-fault");
    if (result.kind === "io-fault") {
      expect(result.offendingPath).toBe("C:\\Users\\pwegner\\.pnpm-store\\v10\\files\\42\\a81d86");
    }
  });

  it("does not extract a path outside the pnpm store — only the store is safe to delete unasked", () => {
    const result = classifySetupFailure({
      stdout: "ERR_PNPM_UNKNOWN  UNKNOWN: unknown error, stat 'C:\\Users\\pwegner\\Documents\\secret.txt'",
    });
    expect(result.kind).toBe("io-fault");
    if (result.kind === "io-fault") {
      expect(result.offendingPath).toBeNull();
    }
  });

  it("leaves an ordinary pnpm failure unclassified", () => {
    const result = classifySetupFailure({ stderr: "ERR_PNPM_FETCH_404 Not Found" });
    expect(result.kind).toBe("unclassified");
  });

  it("is unclassified with no output at all", () => {
    expect(classifySetupFailure({}).kind).toBe("unclassified");
  });

  it("does not stay classified forever off its own persisted banner (#1125 regression)", () => {
    // The banner `describeSetupFailure` writes gets persisted into `stderrTail` and fed back
    // into `classifySetupFailure` on the next sweep. Its label text contains the literal
    // signature, so without stripping the banner first, a workspace whose LATEST failure is
    // completely unrelated (e.g. a 404) would still classify as an io-fault forever.
    const banner = describeSetupFailure(
      classifySetupFailure({ stdout: SAMPLE_OUTPUT("C:\\.pnpm-store\\v10\\files\\42\\x") }),
      { attempted: true, repaired: true, reason: "deleted the corrupted store entry" },
    );
    const result = classifySetupFailure({ stderr: `${banner}\nERR_PNPM_FETCH_404 Not Found` });
    expect(result.kind).toBe("unclassified");
  });
});

describe("repairIoFault (#1125)", () => {
  it("deletes the offending store file, which is safe because the store is content-addressed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kanban-pnpm-store-"));
    const storeDir = path.join(dir, ".pnpm-store", "v10", "files", "42");
    const filePath = path.join(storeDir, "a81d86");
    // mkdtempSync only made `dir`; build the nested store path by hand.
    const fs = await import("node:fs");
    fs.mkdirSync(storeDir, { recursive: true });
    writeFileSync(filePath, "corrupt");
    expect(existsSync(filePath)).toBe(true);

    const classification = classifySetupFailure({ stdout: SAMPLE_OUTPUT(filePath) });
    const result = await repairIoFault(classification);

    expect(result.repaired).toBe(true);
    expect(result.attempted).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  it("reports success (already gone) rather than failure when the file no longer exists", async () => {
    const missingPath = path.join(tmpdir(), ".pnpm-store", "v10", "files", "zz", "does-not-exist");
    const classification = classifySetupFailure({ stdout: SAMPLE_OUTPUT(missingPath) });
    const result = await repairIoFault(classification);
    expect(result.repaired).toBe(true);
    expect(result.reason).toContain("already gone");
  });

  it("does not attempt anything for an unclassified failure", async () => {
    const result = await repairIoFault({ kind: "unclassified" });
    expect(result.attempted).toBe(false);
    expect(result.repaired).toBe(false);
  });

  it("reports honestly, never silently, when no offending path could be extracted", async () => {
    const classification = classifySetupFailure({
      stdout: "ERR_PNPM_UNKNOWN  UNKNOWN: unknown error, stat 'C:\\Users\\pwegner\\Documents\\secret.txt'",
    });
    const result = await repairIoFault(classification);
    expect(result.attempted).toBe(false);
    expect(result.repaired).toBe(false);
    expect(result.reason).toContain("no offending pnpm-store path");
  });
});

describe("describeSetupFailure (#1125)", () => {
  it("names the classification and the repair outcome rather than a bare exit code", () => {
    const classification = classifySetupFailure({ stdout: SAMPLE_OUTPUT("C:\\.pnpm-store\\v10\\files\\42\\x") });
    const line = describeSetupFailure(classification, { attempted: true, repaired: true, reason: "deleted the corrupted store entry" });
    expect(line).toContain("io-fault");
    expect(line).toContain("repaired: deleted the corrupted store entry");
  });

  it("says the repair failed rather than hiding it", () => {
    const classification = classifySetupFailure({ stdout: SAMPLE_OUTPUT("C:\\.pnpm-store\\v10\\files\\42\\x") });
    const line = describeSetupFailure(classification, { attempted: true, repaired: false, reason: "disk still corrupted" });
    expect(line).toContain("repair FAILED: disk still corrupted");
  });

  it("is empty for an unclassified failure — nothing to prefix", () => {
    expect(describeSetupFailure({ kind: "unclassified" })).toBe("");
  });
});
