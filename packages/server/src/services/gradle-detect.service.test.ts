import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  gradleWrapper,
  isKotlinGradle,
  isKotlinMultiplatformGradle,
  isSpringBootGradle,
  isKtorGradle,
  hasGradleApplicationPlugin,
  detectGradleDevPort,
} from "./gradle-detect.service.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kanban-gradle-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const full = join(dir, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

describe("isKotlinGradle", () => {
  it("is true when a Kotlin DSL build script is present", async () => {
    await write("build.gradle.kts", "plugins { id(\"application\") }");
    expect(isKotlinGradle(dir)).toBe(true);
  });

  it("is true for a Groovy build applying a Kotlin plugin", async () => {
    await write("build.gradle", "plugins { id 'org.jetbrains.kotlin.jvm' version '1.9.0' }");
    expect(isKotlinGradle(dir)).toBe(true);
  });

  it("is true when Kotlin sources exist even without a build-script signal", async () => {
    await write("build.gradle", "plugins { id 'java' }");
    await mkdir(join(dir, "src/main/kotlin"), { recursive: true });
    expect(isKotlinGradle(dir)).toBe(true);
  });

  it("is false for a plain Java Groovy build with no Kotlin sources", async () => {
    await write("build.gradle", "plugins { id 'java' }");
    expect(isKotlinGradle(dir)).toBe(false);
  });
});

describe("isKotlinMultiplatformGradle", () => {
  it("detects the multiplatform plugin (KTS)", async () => {
    await write("build.gradle.kts", "plugins { kotlin(\"multiplatform\") }");
    expect(isKotlinMultiplatformGradle(dir)).toBe(true);
  });

  it("is false for a plain kotlin-jvm build", async () => {
    await write("build.gradle.kts", "plugins { kotlin(\"jvm\") }");
    expect(isKotlinMultiplatformGradle(dir)).toBe(false);
  });
});

describe("isSpringBootGradle", () => {
  it("detects the spring-boot plugin", async () => {
    await write("build.gradle", "plugins { id 'org.springframework.boot' version '3.0.0' }");
    expect(isSpringBootGradle(dir)).toBe(true);
  });

  it("detects spring boot via application.properties even without a plugin signal", async () => {
    await write("build.gradle", "plugins { id 'java' }");
    await write("src/main/resources/application.properties", "server.port=9090");
    expect(isSpringBootGradle(dir)).toBe(true);
  });

  it("is false for a non-spring build", async () => {
    await write("build.gradle.kts", "plugins { kotlin(\"jvm\") }");
    expect(isSpringBootGradle(dir)).toBe(false);
  });
});

describe("isKtorGradle", () => {
  it("detects a ktor-server dependency", async () => {
    await write("build.gradle.kts", "dependencies { implementation(\"io.ktor:ktor-server-core:2.3.0\") }");
    expect(isKtorGradle(dir)).toBe(true);
  });

  it("is false for a build with no ktor reference", async () => {
    await write("build.gradle.kts", "plugins { kotlin(\"jvm\") }");
    expect(isKtorGradle(dir)).toBe(false);
  });
});

describe("hasGradleApplicationPlugin", () => {
  it("detects the application plugin", async () => {
    await write("build.gradle.kts", "plugins { application }");
    expect(hasGradleApplicationPlugin(dir)).toBe(true);
  });

  it("detects a mainClass declaration", async () => {
    await write("build.gradle.kts", "application { mainClass.set(\"com.example.MainKt\") }");
    expect(hasGradleApplicationPlugin(dir)).toBe(true);
  });

  it("is false for a library build", async () => {
    await write("build.gradle.kts", "plugins { kotlin(\"jvm\") }");
    expect(hasGradleApplicationPlugin(dir)).toBe(false);
  });
});

describe("gradleWrapper", () => {
  it("returns the platform-appropriate wrapper when present", async () => {
    if (process.platform === "win32") {
      await write("gradlew.bat", "@echo off");
      expect(gradleWrapper(dir)).toBe(".\\gradlew.bat");
    } else {
      await write("gradlew", "#!/bin/sh");
      expect(gradleWrapper(dir)).toBe("./gradlew");
    }
  });

  it("falls back to bare gradle when no wrapper exists", () => {
    expect(gradleWrapper(dir)).toBe("gradle");
  });
});

describe("detectGradleDevPort", () => {
  it("reads a port from application.conf", async () => {
    await write("src/main/resources/application.conf", "ktor { deployment { port = 8123 } }");
    expect(detectGradleDevPort(dir)).toBe(8123);
  });

  it("reads a port from application.properties", async () => {
    await write("src/main/resources/application.properties", "server.port=9091");
    expect(detectGradleDevPort(dir)).toBe(9091);
  });

  it("scans source for an embeddedServer port literal", async () => {
    await write("src/main/kotlin/Main.kt", "fun main() { embeddedServer(Netty, port = 7654) {}.start() }");
    expect(detectGradleDevPort(dir)).toBe(7654);
  });

  it("falls back to 8080 when no port is discoverable", () => {
    expect(detectGradleDevPort(dir)).toBe(8080);
  });
});
