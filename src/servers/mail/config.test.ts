import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { discoverAndWriteConfig, loadEmailConfig, readConfigFile, resolveConfigPath } from "./config"

// The account config is hand-edited, so the behaviour that matters most is what happens to a file
// this code did not write. Previously any read failure -- including a JSON typo -- came back as an
// empty config, which the caller took as "not configured yet" and overwrote with defaults.

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-config-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.MACOS_TOOLS_DATA_DIR
})

const CONFIG = {
  accounts: { "work@host": { label: "Work", category: "work", provider: "gmail" } },
  displayOrder: ["Work"],
}

describe("resolveConfigPath", () => {
  test("follows MACOS_TOOLS_DATA_DIR, the same knob memory.ts uses", () => {
    const dir = tempDir()
    process.env.MACOS_TOOLS_DATA_DIR = dir
    expect(resolveConfigPath()).toBe(join(dir, "email.json"))
  })

  test("defaults to the shared data directory, not the install directory", () => {
    expect(resolveConfigPath()).toBe(join(homedir(), ".local", "share", "macos-tools", "email.json"))
  })
})

describe("readConfigFile", () => {
  test("parses a well-formed config", () => {
    const path = join(tempDir(), "email.json")
    writeFileSync(path, JSON.stringify(CONFIG))
    const loaded = readConfigFile(path)
    expect(loaded.status).toBe("ok")
    expect(loaded.status === "ok" && loaded.config.accounts["work@host"]?.label).toBe("Work")
  })

  test("reports malformed JSON instead of pretending the config is empty", () => {
    const path = join(tempDir(), "email.json")
    writeFileSync(path, '{ "accounts": { "work@host": { "label": "Work" }, }')
    const loaded = readConfigFile(path)
    expect(loaded.status).toBe("invalid")
    expect(loaded.status === "invalid" && loaded.reason.length).toBeGreaterThan(0)
  })

  test("rejects a top-level array, and treats an empty file as not yet written", () => {
    const dir = tempDir()
    writeFileSync(join(dir, "array.json"), "[]")
    expect(readConfigFile(join(dir, "array.json")).status).toBe("invalid")
    writeFileSync(join(dir, "blank.json"), "   \n")
    expect(readConfigFile(join(dir, "blank.json")).status).toBe("missing")
  })

  test("ignores fields of the wrong shape rather than failing the whole file", () => {
    const path = join(tempDir(), "email.json")
    writeFileSync(path, JSON.stringify({ accounts: "nope", displayOrder: "nope" }))
    const loaded = readConfigFile(path)
    expect(loaded.status).toBe("ok")
    expect(loaded.status === "ok" && loaded.config).toEqual({ accounts: {}, displayOrder: [] })
  })
})

describe("loadEmailConfig", () => {
  test("reports missing when neither the current nor the legacy file exists", () => {
    const dir = tempDir()
    expect(loadEmailConfig({ current: join(dir, "email.json"), legacy: join(dir, "old.json") }).status).toBe("missing")
  })

  test("migrates a legacy config forward once", () => {
    const dir = tempDir()
    const legacy = join(dir, "old.json")
    const current = join(dir, "data", "email.json")
    writeFileSync(legacy, JSON.stringify(CONFIG))

    const loaded = loadEmailConfig({ current, legacy })
    expect(loaded.status).toBe("ok")
    expect(existsSync(current)).toBe(true)
    expect(JSON.parse(readFileSync(current, "utf8"))).toEqual(CONFIG)
  })

  test("surfaces a malformed legacy file rather than migrating or discarding it", () => {
    const dir = tempDir()
    const legacy = join(dir, "old.json")
    const current = join(dir, "data", "email.json")
    writeFileSync(legacy, "{ not json")

    expect(loadEmailConfig({ current, legacy }).status).toBe("invalid")
    expect(existsSync(current)).toBe(false)
    expect(readFileSync(legacy, "utf8")).toBe("{ not json")
  })

  test("prefers the current file and leaves the legacy one alone", () => {
    const dir = tempDir()
    const legacy = join(dir, "old.json")
    const current = join(dir, "email.json")
    writeFileSync(legacy, JSON.stringify({ accounts: { stale: {} }, displayOrder: [] }))
    writeFileSync(current, JSON.stringify(CONFIG))

    const loaded = loadEmailConfig({ current, legacy })
    expect(loaded.status === "ok" && Object.keys(loaded.config.accounts)).toEqual(["work@host"])
  })
})

describe("discoverAndWriteConfig", () => {
  const seeded = () => {
    const db = new Database(":memory:")
    db.run(`
      CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);
      INSERT INTO mailboxes (ROWID, url) VALUES
        (1, 'imap://work%40example.com@imap.gmail.com/[Gmail]/All Mail'),
        (2, 'imap://home%40example.com@imap.mail.me.com/INBOX'),
        (3, 'local://Drafts');
    `)
    return db
  }

  test("derives one entry per non-local account and flags Gmail", () => {
    const path = join(tempDir(), "email.json")
    const { config } = discoverAndWriteConfig(seeded(), path)
    expect(Object.keys(config.accounts).sort()).toEqual([
      "home%40example.com@imap.mail.me.com",
      "work%40example.com@imap.gmail.com",
    ])
    expect(config.accounts["work%40example.com@imap.gmail.com"]?.provider).toBe("gmail")
    expect(config.accounts["home%40example.com@imap.mail.me.com"]?.provider).toBe("unknown")
  })

  test("writes the file it reports", () => {
    const path = join(tempDir(), "nested", "email.json")
    const result = discoverAndWriteConfig(seeded(), path)
    expect(result.writeError).toBeUndefined()
    expect(JSON.parse(readFileSync(path, "utf8")).accounts).toEqual(result.config.accounts)
  })

  test("reports a write failure instead of swallowing it", () => {
    // A path under a regular file cannot be created.
    const dir = tempDir()
    const blocker = join(dir, "blocker")
    writeFileSync(blocker, "not a directory")
    const result = discoverAndWriteConfig(seeded(), join(blocker, "email.json"))
    expect(result.writeError).toBeDefined()
    expect(Object.keys(result.config.accounts)).toHaveLength(2)
  })
})
