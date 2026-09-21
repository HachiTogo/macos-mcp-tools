// The mail server's account classification file. It is generated on first use by scanning the
// Envelope Index for mailbox URLs, and a user edits it afterwards to label each account. Reads
// never fail loudly: a missing or unreadable file falls back to an empty config, which triggers
// rediscovery.

import type { Database } from "bun:sqlite"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { getMailboxAccountKey, getMailboxName } from "./mailbox"
import type { EmailAccountConfig, EmailConfig, MailboxUrlRow } from "./types"

export const CONFIG_PATH = resolve(import.meta.dir, "..", "..", "config", "email.json")

export const EMPTY_CONFIG: EmailConfig = {
  accounts: {},
  displayOrder: [],
}

export const loadEmailConfig = (): EmailConfig => {
  try {
    if (!existsSync(CONFIG_PATH)) {
      return EMPTY_CONFIG
    }
    const raw = readFileSync(CONFIG_PATH, "utf8")
    const parsed = JSON.parse(raw) as Partial<EmailConfig>
    return {
      accounts:
        parsed.accounts && typeof parsed.accounts === "object"
          ? (parsed.accounts as Record<string, EmailAccountConfig>)
          : {},
      displayOrder: Array.isArray(parsed.displayOrder) ? parsed.displayOrder : [],
    }
  } catch {
    return EMPTY_CONFIG
  }
}

export const discoverAndWriteConfig = (database: Database): EmailConfig => {
  const mailboxRows = database
    .query("SELECT url AS mailboxUrl FROM mailboxes WHERE url IS NOT NULL")
    .all() as MailboxUrlRow[]
  const allUrls = mailboxRows.map((row) => row.mailboxUrl).filter(Boolean) as string[]

  // Collect unique account keys
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

  const config: EmailConfig = {
    accounts,
    displayOrder: [],
  }

  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true })
    writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  } catch {
    // Non-fatal: config write failure shouldn't break email reading
  }

  return config
}
