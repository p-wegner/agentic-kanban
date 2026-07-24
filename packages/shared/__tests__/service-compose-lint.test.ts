import { describe, it, expect } from "vitest";
import {
  findSiblingComposeRelativePaths,
  siblingComposeRelativePathWarning,
  extractComposeFileReferences,
} from "../src/lib/service-compose-lint.js";

describe("findSiblingComposeRelativePaths (dev #109)", () => {
  it("flags a relative inline env_file", () => {
    const issues = findSiblingComposeRelativePaths(
      ["services:", "  svc:", "    image: redis", "    env_file: ./inv.env"].join("\n"),
    );
    expect(issues).toEqual([{ directive: "env_file", value: "./inv.env" }]);
  });

  it("flags relative env_file entries in block-list form", () => {
    const issues = findSiblingComposeRelativePaths(
      ["services:", "  svc:", "    env_file:", "      - ./a.env", "      - ../b.env"].join("\n"),
    );
    expect(issues).toEqual([
      { directive: "env_file", value: "./a.env" },
      { directive: "env_file", value: "../b.env" },
    ]);
  });

  it("flags a relative build shorthand and a relative build-block context", () => {
    expect(findSiblingComposeRelativePaths("    build: ./app")).toEqual([
      { directive: "context", value: "./app" },
    ]);
    expect(
      findSiblingComposeRelativePaths(["    build:", "      context: ../svc"].join("\n")),
    ).toEqual([{ directive: "context", value: "../svc" }]);
  });

  it("flags relative secret/config file sources", () => {
    const issues = findSiblingComposeRelativePaths(
      ["secrets:", "  s:", "    file: ./secret.txt", "configs:", "  c:", "    file: cfg.json"].join("\n"),
    );
    expect(issues).toEqual([
      { directive: "file", value: "./secret.txt" },
      { directive: "file", value: "cfg.json" },
    ]);
  });

  it("does NOT flag absolute or interpolated paths (the working case stays silent)", () => {
    const text = [
      "services:",
      "  svc:",
      "    env_file: /etc/app/.env",
      "    build:",
      "      context: C:\\repo\\app",
      "secrets:",
      "  s:",
      "    file: ${SECRET_PATH}",
      "configs:",
      "  c:",
      "    file: D:/data/cfg.json",
    ].join("\n");
    expect(findSiblingComposeRelativePaths(text)).toEqual([]);
  });

  it("ignores commented-out directives", () => {
    expect(findSiblingComposeRelativePaths("    # env_file: ./x.env")).toEqual([]);
  });

  it("handles quoted relative values", () => {
    expect(findSiblingComposeRelativePaths('    env_file: "./quoted.env"')).toEqual([
      { directive: "env_file", value: "./quoted.env" },
    ]);
  });

  it("flags a relative volumes bind-mount source in short form (dev #162)", () => {
    const issues = findSiblingComposeRelativePaths(
      ["services:", "  db:", "    image: postgres", "    volumes:", "      - ./seed:/docker-entrypoint-initdb.d"].join("\n"),
    );
    expect(issues).toEqual([{ directive: "volume", value: "./seed" }]);
  });

  it("does NOT flag a named volume reference in the volumes list", () => {
    const issues = findSiblingComposeRelativePaths(
      ["services:", "  db:", "    volumes:", "      - dbdata:/var/lib/postgresql/data"].join("\n"),
    );
    expect(issues).toEqual([]);
  });

  it("flags a relative volumes bind-mount source in long (type: bind) form", () => {
    const issues = findSiblingComposeRelativePaths(
      [
        "services:",
        "  db:",
        "    volumes:",
        "      - type: bind",
        "        source: ../db-init",
        "        target: /docker-entrypoint-initdb.d",
      ].join("\n"),
    );
    expect(issues).toEqual([{ directive: "volume", value: "../db-init" }]);
  });

  it("flags a relative dockerfile path outside a flagged build context", () => {
    const issues = findSiblingComposeRelativePaths(
      ["services:", "  app:", "    build:", "      context: /abs/app", "      dockerfile: ../shared/Dockerfile"].join(
        "\n",
      ),
    );
    expect(issues).toEqual([{ directive: "dockerfile", value: "../shared/Dockerfile" }]);
  });

  it("does not mangle multiple long-form (mapping) env_file list entries (dev #162 fix)", () => {
    const issues = findSiblingComposeRelativePaths(
      [
        "services:",
        "  svc:",
        "    env_file:",
        "      - path: ./a.env",
        "        required: false",
        "      - path: ./b.env",
        "        required: true",
      ].join("\n"),
    );
    expect(issues).toEqual([
      { directive: "env_file", value: "./a.env" },
      { directive: "env_file", value: "./b.env" },
    ]);
  });
});

describe("extractComposeFileReferences (dev #162)", () => {
  it("extracts an include: list in dash form", () => {
    expect(
      extractComposeFileReferences(["include:", "  - ./base.yml", "  - ../shared/other.yml"].join("\n")),
    ).toEqual(["./base.yml", "../shared/other.yml"]);
  });

  it("extracts an include: list in path: mapping form", () => {
    expect(
      extractComposeFileReferences(["include:", "  - path: ./base.yml"].join("\n")),
    ).toEqual(["./base.yml"]);
  });

  it("extracts an extends: block file reference", () => {
    expect(
      extractComposeFileReferences(
        ["services:", "  svc:", "    extends:", "      file: ./base.yml", "      service: base"].join("\n"),
      ),
    ).toEqual(["./base.yml"]);
  });

  it("extracts an inline extends: file reference", () => {
    expect(
      extractComposeFileReferences("    extends: { file: ./base.yml, service: base }"),
    ).toEqual(["./base.yml"]);
  });

  it("ignores ${VAR} interpolated references and dedupes", () => {
    expect(
      extractComposeFileReferences(
        ["include:", "  - ./base.yml", "  - ./base.yml", "  - ${DYNAMIC_INCLUDE}"].join("\n"),
      ),
    ).toEqual(["./base.yml"]);
  });
});

describe("siblingComposeRelativePathWarning", () => {
  it("returns null when there are no issues (success path is silent)", () => {
    expect(
      siblingComposeRelativePathWarning({
        siblingName: "inv",
        siblingComposeAbsPath: "/x/inv/docker-compose.yml",
        leadingWorktreePath: "/x/backend",
        issues: [],
      }),
    ).toBeNull();
  });

  it("names the sibling, the leading worktree, and the offending paths", () => {
    const w = siblingComposeRelativePathWarning({
      siblingName: "inventory-svc",
      siblingComposeAbsPath: "/x/inventory-svc/docker-compose.yml",
      leadingWorktreePath: "/x/backend",
      issues: [{ directive: "env_file", value: "./inv.env" }],
    });
    expect(w).toContain("inventory-svc");
    expect(w).toContain("/x/backend");
    expect(w).toContain("./inv.env");
    expect(w).toContain("#109");
  });
});
