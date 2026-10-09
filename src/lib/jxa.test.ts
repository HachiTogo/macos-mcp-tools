import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Glob } from "bun"

import { runJxa } from "./jxa"

describe("runJxa", () => {
  test("passes args as JSON in argv[0]", () => {
    expect(runJxa("function run(argv) { return JSON.parse(argv[0]).name }", { name: "inbox" })).toBe("inbox")
  })

  test("returns output past spawnSync's 1 MiB default", () => {
    // A message source with an attachment runs to megabytes; the default failed it with ENOBUFS.
    expect(runJxa('function run() { return "a".repeat(3000000) }')).toHaveLength(3_000_000)
  })

  test("kills a script that outlives its timeout", () => {
    expect(() => runJxa('function run() { delay(5); return "late" }', {}, { timeoutMs: 500 })).toThrow("ETIMEDOUT")
  })
})

describe("osascript", () => {
  test("is spawned only through runJxa", () => {
    const root = join(import.meta.dir, "../..")
    const sources = [...new Glob("src/**/*.ts").scanSync(root)].filter(
      (path) => !path.endsWith(".test.ts") && path !== "src/lib/jxa.ts",
    )
    // Guards against a scan that finds nothing and so passes without checking anything.
    expect(sources).toContain("src/servers/mail/read.ts")
    expect(sources.length).toBeGreaterThan(20)
    const offenders = sources.filter((path) =>
      /(spawnSync|spawn|execFile|execFileSync)\(\s*"osascript"/.test(readFileSync(join(root, path), "utf8")),
    )
    expect(offenders).toEqual([])
  })
})
