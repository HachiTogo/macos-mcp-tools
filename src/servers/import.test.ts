import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SERVERS = ["mail", "contacts", "notes", "memory", "messages", "events", "reminders"]

describe("importing a server module", () => {
  // Tests and cli.ts import these modules; only running one as a server may open stdio or create
  // the data directory. Each import runs in a fresh process with HOME pointed at an empty directory.
  // macOS itself may create ~/Library there, so the check is on the servers' own ~/.local tree.
  for (const server of SERVERS) {
    test(`${server} creates no data directory in the user's home`, () => {
      const home = mkdtempSync(join(tmpdir(), "macos-mcp-tools-home-"))
      try {
        const env: Record<string, string> = { HOME: home }
        for (const [key, value] of Object.entries(process.env)) {
          if (value !== undefined && key !== "HOME" && key !== "MACOS_TOOLS_DATA_DIR") env[key] = value
        }
        const modulePath = join(import.meta.dir, `${server}.ts`)
        const result = spawnSync(process.execPath, ["-e", `await import(${JSON.stringify(modulePath)})`], {
          env,
          encoding: "utf8",
        })
        expect(result.status, result.stderr).toBe(0)
        expect(existsSync(join(home, ".local"))).toBe(false)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })
  }
})
