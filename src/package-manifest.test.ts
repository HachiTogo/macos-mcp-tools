import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"

// `package.json` `files` uses globs so that source files added under `src/` ship without anyone
// remembering to update it; a hand-maintained allowlist has already dropped files from a release
// (CHANGELOG 0.0.3). These tests are the other half of that guarantee: the globs have to actually
// resolve to every tracked source file, and nothing else may ride along.

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
}

function trackedSourceFiles(): string[] {
  return run("git", ["ls-files", "src"])
    .split("\n")
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.startsWith("src/integration/"))
}

type PackedTarball = { files?: { path: string }[] }

// npm 11 reports one array entry per tarball; npm 12 reports an object keyed by package name.
// Contributors run whatever npm they have, so read both rather than pinning the local toolchain,
// and throw on anything else instead of quietly reporting an empty package.
function packedFiles(): string[] {
  const parsed: unknown = JSON.parse(run("npm", ["pack", "--dry-run", "--json"]))
  const tarballs: PackedTarball[] = Array.isArray(parsed)
    ? parsed
    : Object.values(parsed as Record<string, PackedTarball>)
  const files = tarballs.flatMap((tarball) => tarball.files ?? [])
  if (files.length === 0) {
    throw new Error(
      `npm pack --dry-run --json (npm ${run("npm", ["--version"]).trim()}) listed no files; its output shape may have changed again`,
    )
  }
  return files.map((file) => file.path)
}

describe("npm package manifest", () => {
  const packed = packedFiles()

  test("ships every tracked source file under src/", () => {
    const sources = trackedSourceFiles()
    expect(sources.length).toBeGreaterThan(0)
    expect(sources.filter((file) => !packed.includes(file))).toEqual([])
  })

  test("ships the entrypoint and the Swift build inputs", () => {
    const required = [
      "bin/macos-tools.js",
      "swift/EventKitCLI.swift",
      "swift/EventKitCLI.entitlements",
      "swift/Info.plist",
      "swift/build.mjs",
    ]
    expect(required.filter((file) => !packed.includes(file))).toEqual([])
  })

  // The binary is a build output, not a tracked file, so a checkout that has never run
  // `bun run build:swift` fails here. Say so, rather than leaving a bare assertion failure.
  test("ships the EventKit binary", () => {
    if (!existsSync("bin/EventKitCLI")) {
      throw new Error("bin/EventKitCLI does not exist. Run `bun run build:swift` first (CI builds it before tests).")
    }
    expect(packed).toContain("bin/EventKitCLI")
  })

  test("ships no tests or integration fixtures", () => {
    expect(packed.filter((file) => file.endsWith(".test.ts") || file.startsWith("src/integration/"))).toEqual([])
  })
})
