import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSetupScript, translatePosixWrapperForWindows } from "../src/lib/setup-script.js";

/**
 * Regression for #181: a `verify_script`/`setup_script` of `./gradlew build` (or
 * `./mvnw ...`) failed the pre-merge gate on Windows with `pre_merge_gate_failed` —
 * cmd.exe parses `./gradlew` as the command `.` and fails outright, even though the
 * same script runs fine on POSIX shells and inside a container (/bin/sh -c).
 */
describe("translatePosixWrapperForWindows (#181)", () => {
  it("rewrites a leading ./gradlew invocation to the cmd.exe-runnable .bat form", () => {
    expect(translatePosixWrapperForWindows("./gradlew build")).toBe(".\\gradlew.bat build");
  });

  it("rewrites a leading ./mvnw invocation to the cmd.exe-runnable .cmd form", () => {
    expect(translatePosixWrapperForWindows("./mvnw test")).toBe(".\\mvnw.cmd test");
  });

  it("rewrites a chained wrapper invocation after &&", () => {
    expect(translatePosixWrapperForWindows("pnpm install && ./gradlew build")).toBe(
      "pnpm install && .\\gradlew.bat build",
    );
  });

  it("leaves an unrelated script untouched", () => {
    expect(translatePosixWrapperForWindows("pnpm test && pnpm build")).toBe("pnpm test && pnpm build");
  });

  it("does not touch a wrapper invocation nested inside another path", () => {
    expect(translatePosixWrapperForWindows("./sub/gradlew build")).toBe("./sub/gradlew build");
  });
});

describe("runSetupScript with a ./gradlew-style verify_script on win32 (#181)", () => {
  it.runIf(process.platform === "win32")(
    "runs a ./gradlew wrapper script successfully via the translated .bat form",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "ak-setup-gradlew-"));
      try {
        const sentinel = join(dir, "sentinel.txt");
        // Stand in for the real gradle wrapper: a batch file the translated command
        // must actually locate and execute.
        writeFileSync(
          join(dir, "gradlew.bat"),
          `@echo off\r\necho ran > "${sentinel}"\r\nexit /b 0\r\n`,
        );
        const result = await runSetupScript(dir, "./gradlew build");
        expect(result.exitCode).toBe(0);
        expect(existsSync(sentinel)).toBe(true);
        expect(readFileSync(sentinel, "utf8").trim()).toBe("ran");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
