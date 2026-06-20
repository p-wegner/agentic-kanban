/**
 * Rule-based detection of a Gradle/Kotlin project's shape from its build scripts
 * and source layout. Extracted from stack-profile.service.ts so the Gradle/KMP/
 * Ktor heuristics — the gnarliest, most platform-sensitive part of stack
 * detection — can be unit-tested in isolation against a temp repo.
 *
 * All functions are deterministic given the on-disk repo at `repoPath`. They read
 * the filesystem but hold no state and reach no DB/network.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Concatenated text of whichever Gradle build script(s) the repo has (KTS or Groovy). */
function gradleBuildText(repoPath: string): string {
  return readFileSafe(join(repoPath, "build.gradle.kts")) + "\n" + readFileSafe(join(repoPath, "build.gradle"));
}

/** True for any directory entry that looks like a Kotlin source file (shallow check is enough). */
function repoHasKotlinSources(repoPath: string): boolean {
  // commonMain (KMP) and main (kotlin-jvm) are the conventional roots; a `.kt` anywhere under
  // src is a strong signal. A shallow existence check of the usual roots avoids a deep walk.
  for (const dir of ["src/commonMain/kotlin", "src/main/kotlin", "src/jvmMain/kotlin"]) {
    if (existsSync(join(repoPath, dir))) return true;
  }
  return false;
}

/**
 * The runnable Gradle wrapper invocation for THIS platform.
 *
 * The board's verify gate and setup runner execute commands through `cmd.exe /c` on Windows
 * (see setup-script.ts / verify-gate-runner.js). Under cmd.exe, `./gradlew` is a parse error
 * ("'.' is not recognized") and a bare `gradlew.bat` is not found from the cwd — only the
 * explicit `.\gradlew.bat` resolves. On POSIX shells `./gradlew` is correct. Emitting the
 * platform-correct wrapper is what makes a Gradle project's merge gate actually pass on Windows.
 */
export function gradleWrapper(repoPath: string): string {
  if (process.platform === "win32") {
    return existsSync(join(repoPath, "gradlew.bat")) ? ".\\gradlew.bat" : "gradle";
  }
  return existsSync(join(repoPath, "gradlew")) ? "./gradlew" : "gradle";
}

/** A Gradle project is Kotlin when it uses the Kotlin DSL or applies a Kotlin plugin / has .kt sources. */
export function isKotlinGradle(repoPath: string): boolean {
  if (existsSync(join(repoPath, "build.gradle.kts"))) return true; // Kotlin DSL ⇒ Kotlin tooling
  const text = gradleBuildText(repoPath).toLowerCase();
  if (/kotlin\(|org\.jetbrains\.kotlin|kotlin-gradle-plugin|kotlin\("multiplatform"\)/.test(text)) return true;
  return repoHasKotlinSources(repoPath);
}

/**
 * A Gradle project is Kotlin Multiplatform when it applies the `multiplatform` plugin. KMP has NO
 * aggregate `test` task (that's a Java-plugin convention) — it exposes `allTests` (which fans out to
 * `jvmTest`/`jsNodeTest`/…). Running `./gradlew test` against a KMP build fails "Task 'test' not
 * found", so the test/verify command must target `allTests` instead.
 */
export function isKotlinMultiplatformGradle(repoPath: string): boolean {
  const text = gradleBuildText(repoPath).toLowerCase();
  return /kotlin\(\s*["']multiplatform["']\s*\)|org\.jetbrains\.kotlin\.multiplatform|kotlin-multiplatform/.test(text);
}

/** A Gradle project is a Spring Boot app when the boot plugin/dependency is present. */
export function isSpringBootGradle(repoPath: string): boolean {
  const text = gradleBuildText(repoPath).toLowerCase();
  if (/spring-boot|org\.springframework\.boot/.test(text)) return true;
  return (
    existsSync(join(repoPath, "src", "main", "resources", "application.properties")) ||
    existsSync(join(repoPath, "src", "main", "resources", "application.yml"))
  );
}

/** A Gradle project is a Ktor (HTTP server) app when a ktor-server dependency/plugin is present. */
export function isKtorGradle(repoPath: string): boolean {
  return /io\.ktor|ktor-server|ktor\b/.test(gradleBuildText(repoPath).toLowerCase());
}

/**
 * True when the Gradle `application` plugin is applied — it contributes the `run` task that boots
 * the app's main class. Used to derive a dev/run command for non-Spring JVM apps (e.g. Ktor).
 */
export function hasGradleApplicationPlugin(repoPath: string): boolean {
  const text = gradleBuildText(repoPath).toLowerCase();
  // `application` in the plugins block, the legacy `apply plugin: "application"`, or a `mainClass`
  // declaration all indicate the application plugin / a runnable main.
  return /\bapplication\b|["']application["']|mainclass/.test(text);
}

/** Common dev-server port literals an HTTP framework binds, in source or config. */
const GRADLE_DEV_PORT_RE = /(?:port\s*[=:(]\s*|:)(\d{4,5})\b/;

/**
 * Best-effort dev-server port for a JVM web app. Scans the main Kotlin/Java source and common
 * config files for a `port = NNNN` / `:NNNN` literal; falls back to 8080 (the Ktor/Spring default)
 * since the smoke check needs a concrete health URL to poll.
 */
export function detectGradleDevPort(repoPath: string): number {
  const candidates = [
    "src/main/resources/application.conf",
    "src/main/resources/application.properties",
    "src/main/resources/application.yml",
  ];
  for (const rel of candidates) {
    const m = readFileSafe(join(repoPath, rel)).match(GRADLE_DEV_PORT_RE);
    if (m) {
      const port = Number.parseInt(m[1], 10);
      if (port > 0 && port < 65536) return port;
    }
  }
  // Scan a shallow set of main source files for an embeddedServer(..., port = NNNN) literal.
  const srcRoots = ["src/main/kotlin", "src/main/java"];
  for (const root of srcRoots) {
    const dir = join(repoPath, root);
    if (!existsSync(dir)) continue;
    for (const file of walkSourceFiles(dir, 40)) {
      const m = readFileSafe(file).match(/embeddedServer[\s\S]{0,80}?port\s*=\s*(?:[^\d]*?)(\d{4,5})/);
      if (m) {
        const port = Number.parseInt(m[1], 10);
        if (port > 0 && port < 65536) return port;
      }
    }
  }
  return 8080;
}

/** Shallow recursive walk yielding up to `limit` source files (.kt/.java) under a directory. */
function walkSourceFiles(dir: string, limit: number): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0 && out.length < limit) {
    const current = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(current, name);
      try {
        if (statSync(full).isDirectory()) stack.push(full);
        else if (/\.(kt|java)$/.test(name)) out.push(full);
      } catch {
        /* skip unreadable entry */
      }
      if (out.length >= limit) break;
    }
  }
  return out;
}
