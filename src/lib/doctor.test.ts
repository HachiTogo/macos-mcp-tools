import { describe, expect, test } from "bun:test"

import {
  analyzeHostConfig,
  binaryArchCheck,
  compareVersions,
  exitCodeFor,
  formatReport,
  lipoArchFor,
  versionCheck,
} from "./doctor"

describe("compareVersions", () => {
  test("orders semver numerically", () => {
    expect(compareVersions("0.4.1", "0.4.1")).toBe("current")
    expect(compareVersions("0.4.0", "0.4.1")).toBe("behind")
    expect(compareVersions("0.3.9", "0.10.0")).toBe("behind")
    expect(compareVersions("1.0.0", "0.9.9")).toBe("ahead")
    expect(compareVersions("v0.4.1", "0.4.1")).toBe("current")
    expect(compareVersions("dev", "0.4.1")).toBe("unknown")
  })
})

describe("versionCheck", () => {
  test("warns with an update fix when behind and skips when npm was unreachable", () => {
    const behind = versionCheck("0.4.0", "0.4.1")
    expect(behind.status).toBe("warn")
    expect(behind.fix).toContain("bun pm cache rm")
    expect(versionCheck("0.4.1", "0.4.1").status).toBe("ok")
    expect(versionCheck("0.4.1", undefined).status).toBe("skip")
  })
})

describe("binaryArchCheck", () => {
  test("maps process.arch to lipo names and fails on mismatch", () => {
    expect(lipoArchFor("x64")).toBe("x86_64")
    expect(lipoArchFor("arm64")).toBe("arm64")
    expect(binaryArchCheck(["arm64"], "arm64").status).toBe("ok")
    expect(binaryArchCheck(["arm64", "x86_64"], "x64").status).toBe("ok")
    const mismatch = binaryArchCheck(["arm64"], "x64")
    expect(mismatch.status).toBe("fail")
    expect(mismatch.fix).toContain("build:swift")
    expect(binaryArchCheck(undefined, "arm64").status).toBe("warn")
  })
})

describe("analyzeHostConfig", () => {
  const exists = (p: string) => p === "/Users/me/.cache/.bun/bin/macos-mcp-tools"

  test("passes absolute, existing launcher paths", () => {
    const results = analyzeHostConfig(
      "Claude Desktop",
      { mcpServers: { apple_mail: { command: "/Users/me/.cache/.bun/bin/macos-mcp-tools", args: ["mail"] } } },
      exists,
    )
    expect(results).toEqual([
      { name: "Claude Desktop: apple_mail", status: "ok", detail: "/Users/me/.cache/.bun/bin/macos-mcp-tools mail" },
    ])
  })

  test("fails bunx and npx launchers with the global-install fix", () => {
    const results = analyzeHostConfig(
      "Claude Desktop",
      {
        mcpServers: {
          a: { command: "/opt/homebrew/bin/bunx", args: ["@hachitogo/macos-mcp-tools@latest", "events"] },
          b: { command: "npx", args: ["@hachitogo/macos-mcp-tools", "notes"] },
        },
      },
      exists,
    )
    expect(results.map((r) => r.status)).toEqual(["fail", "fail"])
    expect(results[0].detail).toContain("bunx")
    expect(results[0].fix).toContain("bun install -g")
  })

  test("fails relative commands and missing files", () => {
    const results = analyzeHostConfig(
      "Claude Desktop",
      {
        mcpServers: {
          rel: { command: "macos-mcp-tools", args: ["mail"] },
          gone: { command: "/Users/me/.bun/bin/macos-mcp-tools", args: ["mail"] },
        },
      },
      exists,
    )
    expect(results[0].status).toBe("fail")
    expect(results[0].detail).toContain("not an absolute path")
    expect(results[1].status).toBe("fail")
    expect(results[1].detail).toContain("does not exist")
  })

  test("ignores unrelated servers and reports skip when none match", () => {
    const results = analyzeHostConfig(
      "Claude Desktop",
      { mcpServers: { other: { command: "/usr/bin/python3", args: ["-m", "something"] } } },
      exists,
    )
    expect(results).toEqual([
      { name: "Claude Desktop", status: "skip", detail: "no macos-mcp-tools servers configured" },
    ])
    expect(analyzeHostConfig("Claude Code", null, exists)[0].status).toBe("skip")
  })
})

describe("formatReport and exitCodeFor", () => {
  test("renders aligned rows, fixes for non-ok checks, and a summary line", () => {
    const report = formatReport([
      { name: "A", status: "ok", detail: "fine", fix: "not shown" },
      { name: "Longer name", status: "fail", detail: "broken", fix: "do this" },
      { name: "S", status: "skip", detail: "n/a" },
    ])
    expect(report).toContain("✔ A            fine")
    expect(report).toContain("✖ Longer name  broken")
    expect(report).toContain("fix: do this")
    expect(report).not.toContain("not shown")
    expect(report.trim().endsWith("1 ok, 0 warnings, 1 failures, 1 skipped")).toBe(true)
  })

  test("exit code is 1 only when something failed", () => {
    expect(exitCodeFor([{ name: "a", status: "warn", detail: "" }])).toBe(0)
    expect(exitCodeFor([{ name: "a", status: "fail", detail: "" }])).toBe(1)
  })
})
