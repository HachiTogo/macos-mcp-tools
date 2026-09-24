// The mail server's account classification file: which label, category and provider each Apple
// Mail account has. It is generated on first use by scanning the Envelope Index for mailbox URLs,
// and then hand-edited, so the one thing this module must never do is overwrite a file a user has
// written. A file that does not parse is reported, not replaced.

import type { Database } from "bun:sqlite"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { getMailboxAccountKey, getMailboxName } from "./mailbox"
import type { EmailAccountConfig, EmailConfig, MailboxUrlRow } from "./types"

export const EMPTY_CONFIG: EmailConfig = {
  accounts: {},
  displayOrder: [],
}

/**
 * The same data directory memory.ts uses, so both servers keep their state in one place and a
 * reinstall does not take it with them.
 */
export const resolveConfigPath = (): string => {
  const dataDir = process.env.MACOS_TOOLS_DATA_DIR
    ? resolve(process.env.MACOS_TOOLS_DATA_DIR)
    : join(homedir(), ".local", "share", "macos-tools")
  return join(dataDir, "email.json")
}

/**
 * Where the config lived before: inside the install directory. Under a global install that
 * directory is replaced on every upgrade, and under `bunx` it is a shared temp path that may not
 * be writable at all. Read once and copied forward.
 */
export const legacyConfigPath = (): string => resolve(import.meta.dir, "..", "..", "config", "email.json")

export type ConfigLoad =
  /** Parsed and usable. */
  | { status: "ok"; config: EmailConfig }
  /** No file yet, or an empty one: discovery may write a starting point. */
  | { status: "missing" }
  /** A file exists but cannot be used. Never overwrite this; the user wrote it. */
  | { status: "invalid"; reason: string }

const asConfig = (parsed: Partial<EmailConfig>): EmailConfig => ({
  accounts:
    parsed.accounts && typeof parsed.accounts === "object" && !Array.isArray(parsed.accounts)
      ? (parsed.accounts as Record<string, EmailAccountConfig>)
      : {},
  displayOrder: Array.isArray(parsed.displayOrder) ? parsed.displayOrder : [],
})

export const readConfigFile = (path: string): ConfigLoad => {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    return { status: "invalid", reason: error instanceof Error ? error.message : String(error) }
  }

  if (raw.trim() === "") {
    return { status: "missing" }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { status: "invalid", reason: error instanceof Error ? error.message : String(error) }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "invalid", reason: "expected a JSON object" }
  }

  return { status: "ok", config: asConfig(parsed as Partial<EmailConfig>) }
}

export const loadEmailConfig = (paths?: { current?: string; legacy?: string }): ConfigLoad => {
  const current = paths?.current ?? resolveConfigPath()
  const legacy = paths?.legacy ?? legacyConfigPath()

  if (existsSync(current)) {
    return readConfigFile(current)
  }

  // One-time migration. A legacy file that does not parse is still reported rather than discarded,
  // so a user who hand-edited it hears about the typo instead of losing the file.
  if (existsSync(legacy)) {
    const loaded = readConfigFile(legacy)
    if (loaded.status === "ok") {
      try {
        mkdirSync(dirname(current), { recursive: true })
        copyFileSync(legacy, current)
      } catch {
        // Migration is best-effort; the legacy file still answered the question.
      }
    }
    return loaded
  }

  return { status: "missing" }
}

export type DiscoveryResult = {
  config: EmailConfig
  path: string
  /** Set when the file could not be written, so the caller can say so instead of silently losing it. */
  writeError?: string
}

export const discoverAndWriteConfig = (database: Database, targetPath?: string): DiscoveryResult => {
  const path = targetPath ?? resolveConfigPath()
  const mailboxRows = database
    .query("SELECT url AS mailboxUrl FROM mailboxes WHERE url IS NOT NULL")
    .all() as MailboxUrlRow[]
  const allUrls = mailboxRows.map((row) => row.mailboxUrl).filter(Boolean) as string[]

  const accountKeys = new Set<string>()
  const gmailAccountKeys = new Set<string>()

  for (const url of allUrls) {
    if (url.startsWith("local://")) continue
    const key = getMailboxAccountKey(url)
    accountKeys.add(key)
    const mailboxName = getMailboxName(url).toLowerCase()
    if (mailboxName === "[gmail]" || mailboxName.startsWith("[gmail]/")) {
      gmailAccountKeys.add(key)
    }
  }

  const accounts: Record<string, EmailAccountConfig> = {}
  for (const key of accountKeys) {
    accounts[key] = {
      label: "unknown",
      category: "unknown",
      provider: gmailAccountKeys.has(key) ? "gmail" : "unknown",
    }
  }

  const config: EmailConfig = { accounts, displayOrder: [] }

  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8")
    return { config, path }
  } catch (error) {
    return { config, path, writeError: error instanceof Error ? error.message : String(error) }
  }
}
