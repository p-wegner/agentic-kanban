import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveVerifyScript } from "../services/project-setup.service.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kanban-verify-"));
}

describe("deriveVerifyScript", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tmp();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("suggests pnpm test && pnpm build for a pnpm node repo with test and build scripts", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest", build: "tsc" } }),
    );
    const result = deriveVerifyScript(dir, ["package.json", "pnpm-lock.yaml"]);
    expect(result).toBe("pnpm test && pnpm build");
  });

  it("suggests npm test for a npm node repo with only a test script", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "jest" } }),
    );
    const result = deriveVerifyScript(dir, ["package.json"]);
    expect(result).toBe("npm test");
  });

  it("suggests yarn test && yarn build for a yarn node repo with test and build scripts", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "jest", build: "webpack" } }),
    );
    const result = deriveVerifyScript(dir, ["package.json", "yarn.lock"]);
    expect(result).toBe("yarn test && yarn build");
  });

  it("returns empty string for a node repo with no test or build scripts", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { start: "node index.js" } }),
    );
    const result = deriveVerifyScript(dir, ["package.json"]);
    expect(result).toBe("");
  });

  it("returns the full cargo verify chain for a Rust repo", () => {
    const result = deriveVerifyScript(dir, ["Cargo.toml"]);
    expect(result).toBe("cargo check && cargo test && cargo build");
  });

  it("returns the full go verify chain for a Go repo", () => {
    const result = deriveVerifyScript(dir, ["go.mod"]);
    expect(result).toBe("go build ./... && go test ./...");
  });

  it("returns the maven verify chain for a Maven repo", () => {
    const result = deriveVerifyScript(dir, ["pom.xml"]);
    expect(result).toBe("mvn test package -B");
  });

  // #521: this used to assert the literal "./gradlew test". On Windows the verify gate
  // spawns through `cmd.exe /d /s /c`, which parses `./gradlew` as the command `.` and
  // exits 1 — so the gate failed and the merge was silently withheld on every JVM
  // project. The wrapper is resolved per platform now, so the assertion follows.
  it("returns a gradle wrapper the host shell can actually execute", () => {
    const result = deriveVerifyScript(dir, ["build.gradle"]);
    // No wrapper file exists in this fixture dir, so both platforms fall back to `gradle`.
    expect(result).toBe("gradle test build --console=plain");
  });

  it("uses the platform-correct wrapper when one exists", async () => {
    const wrapperDir = await mkdtemp(join(tmpdir(), "kanban-verify-gradle-"));
    try {
      await writeFile(join(wrapperDir, "build.gradle.kts"), "plugins { }");
      const isWin = process.platform === "win32";
      await writeFile(join(wrapperDir, isWin ? "gradlew.bat" : "gradlew"), "");
      const result = deriveVerifyScript(wrapperDir, ["build.gradle.kts"]);
      expect(result).toContain(" test build");
      if (isWin) {
        // Must be the .bat form, and must NOT be the POSIX path cmd.exe cannot run.
        expect(result.includes("gradlew.bat")).toBe(true);
        expect(result.startsWith("./")).toBe(false);
      } else {
        expect(result.startsWith("./gradlew ")).toBe(true);
      }
    } finally {
      await rm(wrapperDir, { recursive: true, force: true });
    }
  });

  it("returns make test for a Makefile repo with a test target", async () => {
    await writeFile(join(dir, "Makefile"), "test:\n\tgo test ./...\n");
    const result = deriveVerifyScript(dir, ["Makefile"]);
    expect(result).toBe("make test");
  });

  it("returns empty string for a Makefile repo without a test target", async () => {
    await writeFile(join(dir, "Makefile"), "build:\n\tgo build ./...\n");
    const result = deriveVerifyScript(dir, ["Makefile"]);
    expect(result).toBe("");
  });

  it("returns the python verify chain for a Python repo", () => {
    const result = deriveVerifyScript(dir, ["requirements.txt"]);
    expect(result).toBe("mypy . && python -m pytest -q --no-header --tb=short");
  });

  // #120: bare `python -m pytest` fails with "No module named pytest" in a uv project
  // (deps live in a project-local .venv) and blocked every merge.
  it("runs every python step through uv for a uv repo (pyproject.toml + uv.lock)", async () => {
    await writeFile(join(dir, "pyproject.toml"), '[project]\nname = "x"\n');
    const result = deriveVerifyScript(dir, ["pyproject.toml", "uv.lock"]);
    expect(result).toBe("uv run mypy . && uv run pytest -q --no-header --tb=short");
  });

  it("runs every python step through uv when pyproject declares [tool.uv] without a lockfile", async () => {
    await writeFile(join(dir, "pyproject.toml"), '[project]\nname = "x"\n\n[tool.uv]\n');
    const result = deriveVerifyScript(dir, ["pyproject.toml"]);
    expect(result).toBe("uv run mypy . && uv run pytest -q --no-header --tb=short");
  });

  it("returns bundle exec rake test for a Ruby repo", () => {
    const result = deriveVerifyScript(dir, ["Gemfile"]);
    expect(result).toBe("bundle exec rake test");
  });

  it("returns mix test for an Elixir repo", () => {
    const result = deriveVerifyScript(dir, ["mix.exs"]);
    expect(result).toBe("mix test");
  });

  it("returns empty string when no known markers are detected", () => {
    const result = deriveVerifyScript(dir, []);
    expect(result).toBe("");
  });
});
