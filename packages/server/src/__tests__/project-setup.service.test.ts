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

  it("suggests pnpm test && pnpm run build for a pnpm node repo with test and build scripts", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest", build: "tsc" } }),
    );
    const result = deriveVerifyScript(dir, ["package.json", "pnpm-lock.yaml"]);
    expect(result).toBe("pnpm test && pnpm run build");
  });

  it("suggests npm test for a npm node repo with only a test script", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "jest" } }),
    );
    const result = deriveVerifyScript(dir, ["package.json"]);
    expect(result).toBe("npm test");
  });

  it("suggests yarn test && yarn run build for a yarn node repo with test and build scripts", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "jest", build: "webpack" } }),
    );
    const result = deriveVerifyScript(dir, ["package.json", "yarn.lock"]);
    expect(result).toBe("yarn test && yarn run build");
  });

  it("returns empty string for a node repo with no test or build scripts", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { start: "node index.js" } }),
    );
    const result = deriveVerifyScript(dir, ["package.json"]);
    expect(result).toBe("");
  });

  it("returns cargo test for a Rust repo", () => {
    const result = deriveVerifyScript(dir, ["Cargo.toml"]);
    expect(result).toBe("cargo test");
  });

  it("returns go test ./... for a Go repo", () => {
    const result = deriveVerifyScript(dir, ["go.mod"]);
    expect(result).toBe("go test ./...");
  });

  it("returns mvn test for a Maven repo", () => {
    const result = deriveVerifyScript(dir, ["pom.xml"]);
    expect(result).toBe("mvn test");
  });

  it("returns ./gradlew test for a Gradle repo", () => {
    const result = deriveVerifyScript(dir, ["build.gradle"]);
    expect(result).toBe("./gradlew test");
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

  it("returns python -m pytest for a Python repo", () => {
    const result = deriveVerifyScript(dir, ["requirements.txt"]);
    expect(result).toBe("python -m pytest");
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
