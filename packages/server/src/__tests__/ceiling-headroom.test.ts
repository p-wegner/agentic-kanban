import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractNamedPaths,
  formatCeilingHeadroom,
  measureCeilingHeadroom,
} from "../services/ceiling-headroom.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ceiling-headroom-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const branchy = (n: number) => `export function busy(x: number) {\n${"if (x) { x++; }\n".repeat(n - 1)}return x;\n}\n`;

describe("ceiling headroom (#1606)", () => {
  it("reports a file within 50 lines of the line ceiling", async () => {
    const root = repoWith({ "src/big.ts": "const a = 1;\n".repeat(994) });
    const out = await measureCeilingHeadroom(root, ["src/big.ts"]);
    expect(out).toHaveLength(1);
    expect(out[0].lines).toBe(994);
    expect(formatCeilingHeadroom(out)).toContain("994/1000 lines");
  });

  it("reports a function within 3 branches of the ceiling", async () => {
    const root = repoWith({ "src/busy.ts": branchy(25) });
    const out = await measureCeilingHeadroom(root, ["src/busy.ts"]);
    expect(out[0].worstFunction).toEqual({ name: "busy", branches: 25 });
    expect(formatCeilingHeadroom(out)).toContain("busy() 25/25 branches -> extend in a new module");
  });

  it("omits files with comfortable headroom and renders nothing", async () => {
    const root = repoWith({ "src/small.ts": branchy(5) });
    const out = await measureCeilingHeadroom(root, ["src/small.ts", "src/missing.ts"]);
    expect(out).toEqual([]);
    expect(formatCeilingHeadroom(out)).toBeNull();
  });

  it("extracts paths named in ticket text", () => {
    expect(extractNamedPaths("see `packages/server/src/a.ts` and ./scripts/x.mjs, not foo.ts")).toEqual([
      "packages/server/src/a.ts",
      "scripts/x.mjs",
    ]);
  });
});
