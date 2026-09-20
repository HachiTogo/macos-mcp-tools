// Mailbox URLs and what they say about an account. Apple Mail addresses every message by the URL
// of the mailbox holding it, so parsing that URL is how the server derives an account key, a
// display name and the account's classification from config.

import type { AccountClassification, EmailConfig, EmailHandle } from "./types"

export const UNKNOWN_ACCOUNT_CLASSIFICATION = {
  accountLabel: "unknown",
  accountCategory: "unknown",
} as const satisfies AccountClassification

export const getMailboxAccountKey = (mailboxUrl: string) => mailboxUrl.match(/^[a-z]+:\/\/([^/]+)/i)?.[1] ?? mailboxUrl

export const createEmailHandle = (mailboxUrl: string, mailId: string): EmailHandle => ({
  accountId: getMailboxAccountKey(mailboxUrl),
  mailboxUrl,
  mailId,
})

export const decodeMailboxPath = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export const getMailboxName = (mailboxUrl: string) => {
  const match = mailboxUrl.match(/^[a-z]+:\/\/[^/]+\/(.+)$/i)
  return decodeMailboxPath(match?.[1] ?? mailboxUrl)
}

export const getProviderByAccount = (config: EmailConfig): Map<string, "gmail" | "icloud"> => {
  const result = new Map<string, "gmail" | "icloud">()
  for (const [key, account] of Object.entries(config.accounts)) {
    if (account.provider === "gmail" || account.provider === "icloud") {
      result.set(key, account.provider)
    }
  }
  return result
}

export const classifyAccountByMailboxUrl = (mailboxUrl: string, config: EmailConfig): AccountClassification => {
  const accountKey = getMailboxAccountKey(mailboxUrl)
  const accountConfig = config.accounts[accountKey]
  if (!accountConfig) return UNKNOWN_ACCOUNT_CLASSIFICATION
  return {
    accountLabel: accountConfig.label || "unknown",
    accountCategory: accountConfig.category || "unknown",
  }
}

// Mailbox names are "/"-separated paths (see getMailboxName). A mailbox is excluded when any
// segment starts with one of these names, so both top-level "Junk" and nested "[Gmail]/Spam" match.
export const EXCLUDED_MAILBOX_SEGMENTS = [
  "junk",
  "spam",
  "trash",
  "deleted messages",
  "sent messages",
  "sent mail",
  "drafts",
  "outbox",
] as const

export const isExcludedMailbox = (
  _mailboxUrl: string,
  mailboxName: string,
  provider: "gmail" | "icloud" | string = "icloud",
) => {
  const normalized = mailboxName.toLowerCase()
  const segments = normalized
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)

  const excluded: string[] = [...EXCLUDED_MAILBOX_SEGMENTS]
  // For non-Gmail accounts, also exclude "all mail" to avoid duplicates
  if (provider !== "gmail") {
    excluded.push("all mail")
  }

  return (
    segments.some((segment) => excluded.some((name) => segment.startsWith(name))) ||
    normalized.trim().endsWith("[gmail]")
  )
}
