import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SetupStatusPanel } from "./SetupStatusPanel.js";

describe("SetupStatusPanel", () => {
  it("renders failed setup details with command, exit code, duration, and output", () => {
    const html = renderToStaticMarkup(
      <SetupStatusPanel
        setup={{
          command: "pnpm install",
          state: "failed",
          startedAt: new Date(Date.now() - 5000).toISOString(),
          endedAt: new Date().toISOString(),
          exitCode: 1,
          durationMs: 5000,
          stdoutTail: "installing",
          stderrTail: "missing package",
        }}
      />,
    );

    expect(html).toContain("Setup failed");
    expect(html).toContain("pnpm install");
    expect(html).toContain("Exit 1");
    expect(html).toContain("Duration 5s");
    expect(html).toContain("installing");
    expect(html).toContain("missing package");
  });

  it("renders skipped setup state", () => {
    const html = renderToStaticMarkup(
      <SetupStatusPanel
        setup={{
          command: null,
          state: "skipped",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          exitCode: null,
          durationMs: 0,
          stdoutTail: null,
          stderrTail: null,
        }}
      />,
    );

    expect(html).toContain("Setup skipped");
    expect(html).toContain("Exit -");
  });

  it("renders running setup state", () => {
    const html = renderToStaticMarkup(
      <SetupStatusPanel
        setup={{
          command: "pnpm install",
          state: "running",
          startedAt: new Date().toISOString(),
          endedAt: null,
          exitCode: null,
          durationMs: null,
          stdoutTail: null,
          stderrTail: null,
        }}
      />,
    );

    expect(html).toContain("Setup running");
    expect(html).toContain("Duration running");
    expect(html).toContain("Started");
  });
});
