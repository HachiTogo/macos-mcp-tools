import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"

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

function packedFiles(): string[] {
  const [tarball] = JSON.parse(run("npm", ["pack", "--dry-run", "--json"])) as { files: { path: string }[] }[]
  return tarball.files.map((file) => file.path)
}

describe("npm package manifest", () => {
  const packed = packedFiles()

  test("ships every tracked source file under src/", () => {
    const sources = trackedSourceFiles()
    expect(sources.length).toBeGreaterThan(0)
    expect(sources.filter((file) => !packed.includes(file))).toEqual([])
  })

  test("ships the entrypoint, the EventKit binary and the Swift build inputs", () => {
    const required = [
      "bin/macos-tools.js",
      "bin/EventKitCLI",
      "swift/EventKitCLI.swift",
      "swift/EventKitCLI.entitlements",
      "swift/Info.plist",
      "swift/build.mjs",
    ]
    expect(required.filter((file) => !packed.includes(file))).toEqual([])
  })

  test("ships no tests or integration fixtures", () => {
    expect(packed.filter((file) => file.endsWith(".test.ts") || file.startsWith("src/integration/"))).toEqual([])
  })
})
