// The Node range the board supports (#1457). ONE source for the worker doctor and the toolchain
// remedy; root `package.json` `engines.node` must equal it (node-engines.test.ts pins that).
// Why not ">=22": dependency-cruiser (`pnpm check:arch` / `lint:arch`) supports only ^20.12, ^22 and
// >=24, so 23.x silently cannot run the architecture gate.
export const BOARD_NODE_ENGINES = "^22.0.0 || >=24.0.0";

function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

function cmp(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

/** Tiny semver-range check: `||` alternatives of space-separated `^X.Y.Z`, `>=X`, `>X`, `<X`, `<=X` comparators. */
export function nodeSatisfiesEngines(version: string, range: string = BOARD_NODE_ENGINES): boolean | null {
  const have = parseVersion(version);
  if (!have) return null;
  return range.split("||").some((alt) =>
    alt.trim().split(/\s+/).filter(Boolean).every((c) => {
      const m = /^(\^|>=|<=|>|<)(.+)$/.exec(c);
      const want = m ? parseVersion(m[2]!) : null;
      if (!m || !want) return false;
      const d = cmp(have, want);
      switch (m[1]) {
        case "^": return d >= 0 && have[0] === want[0];
        case ">=": return d >= 0;
        case "<=": return d <= 0;
        case ">": return d > 0;
        default: return d < 0;
      }
    }),
  );
}
