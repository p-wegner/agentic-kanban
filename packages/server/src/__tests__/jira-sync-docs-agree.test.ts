import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = resolve(import.meta.dirname, "..", "..", "plugins", "jira-sync");
const read = (f: string) => readFileSync(resolve(DIR, f), "utf8");

describe("jira-sync docs agree with the code (#1739)", () => {
  it("butler fragment, README and profile template name the same secret store", () => {
    for (const f of ["butler-fragment.md", "README.md", "profile-template.md"]) {
      expect(read(f), f).toMatch(/encrypted in\s+`kanban\.db`/);
    }
    expect(read("butler-fragment.md")).not.toMatch(/never stored in the board's database/);
  });

  it("no doc promises Jira Server/Data Center support the client cannot deliver", () => {
    for (const f of ["README.md", "profile-template.md", "butler-fragment.md"]) {
      expect(read(f), f).not.toMatch(/Personal Access Token \(/i);
      expect(read(f), f).not.toMatch(/bearer token/i);
    }
  });

  it("the butler does not claim TODO markers always block sync", () => {
    expect(read("butler-fragment.md")).not.toMatch(/refuse to run/);
  });
});
