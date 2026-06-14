// Seed the kmp-toolkit fan-out epic via REST. One-shot.
const BASE = "http://localhost:3001";
const PROJECT_ID = "e26fc324-1a62-45bb-8e01-61d37c323790";

const OWNERSHIP_NOTE =
  "Create ONLY these two files; do not edit build.gradle.kts, settings.gradle.kts, Strings.kt, the README, or any other ticket's file. No shared barrel/registry/index. " +
  "Package is `io.kanban.toolkit`. Use plain `kotlin.test` (`import kotlin.test.Test`, `assertEquals`, `assertTrue`, etc.). Pure common-source Kotlin only (no JVM/JS-specific APIs, no java.* imports). " +
  "Verify locally with `./gradlew test && ./gradlew build` before finishing.";

function leaf(name, title, spec) {
  const main = `src/commonMain/kotlin/io/kanban/toolkit/${name}.kt`;
  const test = `src/commonTest/kotlin/io/kanban/toolkit/${name}Test.kt`;
  return {
    title,
    issueType: "task",
    priority: "medium",
    description:
      `${spec}\n\n` +
      `**Files (create ONLY these two):**\n` +
      `- \`${main}\` — the public function(s) described above, in package \`io.kanban.toolkit\`.\n` +
      `- \`${test}\` — a \`kotlin.test\` test class with several assertions covering normal + edge cases.\n\n` +
      OWNERSHIP_NOTE,
  };
}

// 18 independent feature leaves — disjoint files, simple pure utilities.
const leaves = [
  leaf("Palindrome", "Add isPalindrome string utility",
    "Add `fun isPalindrome(input: String): Boolean` returning true if `input` reads the same forwards and backwards. Comparison is case-insensitive and ignores non-alphanumeric characters (so \"A man, a plan, a canal: Panama\" is a palindrome). Empty string is a palindrome."),
  leaf("WordCount", "Add wordCount string utility",
    "Add `fun wordCount(input: String): Int` returning the number of whitespace-separated words. Leading/trailing/duplicate whitespace must not inflate the count; an empty or all-whitespace string returns 0."),
  leaf("Slugify", "Add slugify string utility",
    "Add `fun slugify(input: String): String` converting a string to a URL slug: lowercased, non-alphanumeric runs collapsed to a single '-', leading/trailing '-' trimmed. E.g. \"Hello, World!\" -> \"hello-world\"."),
  leaf("Truncate", "Add truncate string utility",
    "Add `fun truncate(input: String, maxLength: Int, ellipsis: String = \"...\"): String`. If `input.length <= maxLength` return it unchanged; otherwise cut to fit and append `ellipsis` so the total length is exactly `maxLength` (assume maxLength >= ellipsis.length). Throw `IllegalArgumentException` if maxLength is negative."),
  leaf("TitleCase", "Add titleCase string utility",
    "Add `fun titleCase(input: String): String` upper-casing the first letter of each whitespace-separated word and lower-casing the rest. Preserve the original whitespace separators."),
  leaf("Gcd", "Add gcd and lcm math utilities",
    "Add `fun gcd(a: Long, b: Long): Long` (greatest common divisor, always non-negative, gcd(0,0)=0) and `fun lcm(a: Long, b: Long): Long` (least common multiple, lcm with 0 is 0). Use Euclid's algorithm; handle negatives by using absolute values."),
  leaf("Factorial", "Add factorial math utility",
    "Add `fun factorial(n: Int): Long` returning n! for 0 <= n <= 20. Throw `IllegalArgumentException` for negative n or n > 20 (overflows Long). factorial(0) == 1."),
  leaf("IsPrime", "Add isPrime math utility",
    "Add `fun isPrime(n: Long): Boolean` returning true if n is a prime number. n < 2 is not prime. Use trial division up to sqrt(n)."),
  leaf("Clamp", "Add clamp numeric utility",
    "Add `fun clamp(value: Int, min: Int, max: Int): Int` and `fun clamp(value: Double, min: Double, max: Double): Double` constraining value into [min, max]. Throw `IllegalArgumentException` if min > max."),
  leaf("RomanNumerals", "Add toRoman / fromRoman utilities",
    "Add `fun toRoman(n: Int): String` (1..3999) and `fun fromRoman(s: String): Int` (inverse). Throw `IllegalArgumentException` for out-of-range or malformed input. Standard subtractive notation (IV, IX, XL, ...)."),
  leaf("Chunk", "Add chunk collection utility",
    "Add `fun <T> chunk(list: List<T>, size: Int): List<List<T>>` splitting `list` into consecutive sublists of at most `size` elements (last may be smaller). Throw `IllegalArgumentException` if size < 1. Empty list -> empty list."),
  leaf("Distinct", "Add distinctBy-count collection utility",
    "Add `fun <T, K> countDistinctBy(items: List<T>, selector: (T) -> K): Int` returning the number of distinct keys produced by `selector`. Empty list -> 0."),
  leaf("Frequencies", "Add frequencies collection utility",
    "Add `fun <T> frequencies(items: List<T>): Map<T, Int>` mapping each distinct element to how many times it appears, preserving first-seen order (use LinkedHashMap)."),
  leaf("Flatten", "Add flatten collection utility",
    "Add `fun <T> flatten(nested: List<List<T>>): List<T>` concatenating all inner lists in order. Empty / lists of empties -> empty list."),
  leaf("Average", "Add average / median number utilities",
    "Add `fun average(values: List<Double>): Double` and `fun median(values: List<Double>): Double`. Throw `IllegalArgumentException` on empty input. median of even-sized list = mean of the two middle values (after sorting)."),
  leaf("ByteSize", "Add humanReadableBytes formatting utility",
    "Add `fun humanReadableBytes(bytes: Long): String` formatting a byte count with binary units (B, KiB, MiB, GiB, TiB) to one decimal place for non-byte units, e.g. 1024 -> \"1.0 KiB\", 1536 -> \"1.5 KiB\", 500 -> \"500 B\". Handle 0 and negative gracefully (negatives prefixed with '-')."),
  leaf("EmailValidator", "Add isValidEmail validation utility",
    "Add `fun isValidEmail(input: String): Boolean` doing pragmatic email validation: one '@', non-empty local part, a domain with at least one '.', no whitespace. Keep it a simple Kotlin regex/string check (no external libs)."),
  leaf("Hex", "Add hex encode/decode utilities",
    "Add `fun toHex(bytes: ByteArray): String` (lowercase hex, no separators) and `fun fromHex(hex: String): ByteArray` (inverse, accepts upper or lower case). Throw `IllegalArgumentException` on odd-length or non-hex input."),
];

const meta = {
  title: "EPIC: kmp-toolkit pure-utility library (fan-out)",
  issueType: "task",
  priority: "high",
  description:
    "Meta-ticket for the kmp-toolkit fan-out epic. Each child adds ONE standalone pure utility in its OWN new file under " +
    "`src/commonMain/kotlin/io/kanban/toolkit/<Name>.kt` plus its OWN `<Name>Test.kt` test — zero shared/hot files, maximum parallelism. " +
    "The skeleton already builds green (`./gradlew test && ./gradlew build`). One integration child updates the README with the list of available utilities. " +
    "This meta stays In Progress until ALL children are Done AND master actually contains the work, then it moves to Done.\n\n" +
    "Ownership matrix: every leaf owns exactly its two files (NewName.kt + NewNameTest.kt); the README child owns ONLY README.md. No file has more than one owner.",
};

const readme = {
  title: "Document available utilities in README",
  issueType: "task",
  priority: "low",
  description:
    "Create or update `README.md` at the repo root with a section titled \"## Available utilities\" listing each utility function in `io.kanban.toolkit` " +
    "(one bullet per function: signature + one-line description), covering Strings.reverse plus all the utilities added by the sibling tickets (palindrome, wordCount, slugify, truncate, titleCase, gcd/lcm, factorial, isPrime, clamp, roman numerals, chunk, countDistinctBy, frequencies, flatten, average/median, humanReadableBytes, isValidEmail, hex encode/decode).\n\n" +
    "**Files (edit ONLY this one):**\n- `README.md` — the documentation section.\n\n" +
    "Create ONLY this file; do not edit any Kotlin source, build.gradle.kts, or any other ticket's file.",
};

// Batch order: 0 = meta, 1..18 = leaves, 19 = readme
const issues = [meta, ...leaves, readme];

async function main() {
  const res = await fetch(`${BASE}/api/issues/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: PROJECT_ID, issues }),
  });
  const json = await res.json();
  if (res.status !== 201) {
    console.error("BATCH FAILED", res.status, JSON.stringify(json));
    process.exit(1);
  }
  const created = json.issues;
  console.log(`Created ${created.length} issues (#${created[0].issueNumber}..#${created[created.length - 1].issueNumber})`);

  const metaId = created[0].id;
  const leafIds = created.slice(1, 1 + leaves.length).map((i) => i.id);
  const readmeId = created[created.length - 1].id;

  // Tag the meta no-auto-start so the monitor never tries to launch a builder for the epic ticket itself.
  const NO_AUTO_START_TAG = "b09c9161-4e3b-4e9e-84ce-c217a29c7117";
  const tres = await fetch(`${BASE}/api/issues/${metaId}/tags`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tagId: NO_AUTO_START_TAG }),
  });
  console.log(`Tagged meta no-auto-start: ${tres.status}`);

  // Edges:
  // - meta parent_of each child (non-blocking grouping) — all 19 children
  // - readme depends_on each of the 18 leaves (blocking)
  const childIds = [...leafIds, readmeId];
  const edges = [];
  for (const cid of childIds) edges.push({ issueId: metaId, dependsOnId: cid, type: "parent_of", action: "add" });
  for (const lid of leafIds) edges.push({ issueId: readmeId, dependsOnId: lid, type: "depends_on", action: "add" });

  const eres = await fetch(`${BASE}/api/issues/dependencies/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ edges }),
  });
  const ejson = await eres.json();
  if (eres.status !== 200) {
    console.error("EDGES FAILED", eres.status, JSON.stringify(ejson));
    process.exit(1);
  }
  console.log(`Edges: added=${ejson.added} removed=${ejson.removed} skipped=${(ejson.skipped || []).length}`);
  console.log(JSON.stringify({ metaId, metaNumber: created[0].issueNumber, readmeId, readmeNumber: created[created.length-1].issueNumber, leafCount: leafIds.length }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
