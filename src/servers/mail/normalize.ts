// Turning an Envelope Index row into the email shape the tools return. The columns Apple exposes
// are inconsistent -- subjects arrive split across prefix/reference columns, senders as either a
// name or an address -- so each field is resolved from several candidates and blank-normalized.

import {
  classifyAccountByMailboxUrl,
  createEmailHandle,
  getMailboxAccountKey,
  getMailboxName,
  isExcludedMailbox,
} from "./mailbox"
import type { EmailConfig, EmailRow, NormalizedEmail } from "./types"

export const SOURCE_NAME = "Apple Mail Envelope Index"

export const padNumber = (value: number) => String(value).padStart(2, "0")

export const toLocalDateTimeString = (value: Date) =>
  `${value.getFullYear()}-${padNumber(value.getMonth() + 1)}-${padNumber(value.getDate())}T${padNumber(value.getHours())}:${padNumber(value.getMinutes())}:${padNumber(value.getSeconds())}`

export const cleanText = (value: string | null | undefined) => {
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim()
  return normalized || undefined
}

/**
 * Seconds since the epoch for a search bound. A bare `YYYY-MM-DD` means midnight where the user
 * is, not UTC: `new Date("2026-09-01")` is 17:00 the previous day in Pacific time, so `after`
 * silently pulled in the previous evening and `before` cut the last hours of the day. Anything
 * carrying a time or a zone is left to Date, which honours it.
 */
export const toSearchBoundSeconds = (value: string): number => {
  const bareDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (bareDate) {
    const [, year, month, day] = bareDate
    return Math.floor(new Date(Number(year), Number(month) - 1, Number(day)).getTime() / 1000)
  }
  return Math.floor(new Date(value).getTime() / 1000)
}

export const toIsoStringFromUnixSeconds = (value: number | null) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined
  }

  const milliseconds = value > 1_000_000_000_000 ? value : value * 1000
  const date = new Date(milliseconds)

  if (Number.isNaN(date.getTime())) {
    return undefined
  }

  return date.toISOString()
}

export const buildMessageUrl = (messageIdHeader: string | null | undefined): string => {
  if (!messageIdHeader) return ""
  const trimmed = messageIdHeader.trim()
  if (!trimmed) return ""
  // message_id_header is stored with angle brackets: <id@domain>
  // message: URL format: message:%3Cid@domain%3E
  const bare = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed
  if (!bare) return ""
  return `message:%3C${bare}%3E`
}

export const isEmailLike = (value: string | undefined) => Boolean(value?.includes("@"))

export const normalizeSubject = (row: EmailRow) => {
  const resolvedSubject = cleanText(row.resolvedSubject)

  if (resolvedSubject) {
    return resolvedSubject
  }

  const subjectPrefix = cleanText(row.subjectPrefix)

  if (subjectPrefix) {
    return subjectPrefix
  }

  const subjectReference = cleanText(row.subjectReferenceText)

  if (subjectReference && !/^-?\d+$/.test(subjectReference)) {
    return subjectReference
  }

  return "(no subject)"
}

export const normalizeSender = (row: EmailRow) => {
  const senderNameCandidate = cleanText(row.resolvedSenderName)
  const senderAddressCandidate = cleanText(row.resolvedSenderAddress)
  const senderReferenceCandidate = cleanText(row.senderReferenceText)

  const senderAddress =
    senderAddressCandidate ??
    (isEmailLike(senderNameCandidate) ? senderNameCandidate : undefined) ??
    (isEmailLike(senderReferenceCandidate) ? senderReferenceCandidate : undefined) ??
    ""

  const senderName = senderNameCandidate && senderNameCandidate !== senderAddress ? senderNameCandidate : ""

  return {
    senderName,
    senderAddress,
  }
}

/** Gmail's All Mail, under either of the names Gmail uses by region. */
const GMAIL_ALL_MAIL = /^\[(gmail|google mail)\]\/all mail$/i
/** Labels Gmail applies itself. They are not folders a user filed into: Important, Starred, etc. */
const GMAIL_SYSTEM_LABEL = /^\[(gmail|google mail)\](\/|$)/i

type Label = { name: string; url: string }

/**
 * The labels a Gmail message is filed under, INBOX first. Gmail's own system labels do not count:
 * it applies Important automatically, archived mail included, so counting it would bring archived
 * mail back in. Labels are screened by the same exclusions as any other mailbox.
 */
export const filedGmailLabels = (labelMailboxUrls: string | null | undefined): Label[] =>
  (labelMailboxUrls ?? "")
    .split("\n")
    .map((url) => url.trim())
    .filter(Boolean)
    .map((url) => ({ url, name: getMailboxName(url) }))
    .filter((label) => label.name && !GMAIL_SYSTEM_LABEL.test(label.name))
    .filter((label) => !isExcludedMailbox(label.url, label.name, "gmail"))
    .sort((a, b) => Number(b.name === "INBOX") - Number(a.name === "INBOX") || a.name.localeCompare(b.name))

export type NormalizeOptions = {
  /**
   * Whether a Gmail message with no filed label -- archived, in Gmail's terms -- is kept. Unread
   * reads leave it out; searches keep it, since finding old archived mail is what search is for.
   */
  includeArchivedGmail: boolean
}

export const normalizeEmail = (
  row: EmailRow,
  providerByAccount: Map<string, "gmail" | "icloud">,
  config: EmailConfig,
  options: NormalizeOptions,
) => {
  const mailboxUrl = cleanText(row.mailboxUrl) ?? ""

  if (!mailboxUrl) {
    return undefined
  }

  const mailboxName = getMailboxName(mailboxUrl)
  const accountKey = getMailboxAccountKey(mailboxUrl)
  let provider = providerByAccount.get(accountKey) ?? "icloud"

  // Where the message is reported. Every account but Gmail: the mailbox it is stored in.
  let displayMailboxName = mailboxName
  let displayMailboxUrl = mailboxUrl
  let labels: string[] | undefined

  if (GMAIL_ALL_MAIL.test(mailboxName)) {
    // Gmail stores every message here and expresses folders as labels, so the storage mailbox says
    // nothing about where the message is filed. Report its first filed label instead -- INBOX when
    // it has one -- and treat a message with no filed label as archived.
    provider = "gmail"
    const filed = filedGmailLabels(row.labelMailboxUrls)
    if (filed.length === 0 && !options.includeArchivedGmail) {
      return undefined
    }
    if (filed[0]) {
      displayMailboxName = filed[0].name
      displayMailboxUrl = filed[0].url
    }
    labels = filed.map((label) => label.name)
  } else if (isExcludedMailbox(mailboxUrl, mailboxName, provider)) {
    return undefined
  }

  const messageId = cleanText(row.messageIdText) ?? ""
  const accountClassification = classifyAccountByMailboxUrl(mailboxUrl, config)
  const receivedAt = toIsoStringFromUnixSeconds(row.receivedAtUnix)
  const receivedAtDate = receivedAt ? new Date(receivedAt) : undefined
  const sender = normalizeSender(row)
  const messageUrl = buildMessageUrl(row.messageIdHeader)

  return {
    id: messageId || cleanText(row.documentId) || row.rowIdText,
    // The handle names the mailbox the message is stored in, which is where Mail.app finds it.
    handle: createEmailHandle(mailboxUrl, row.rowIdText),
    subject: normalizeSubject(row),
    senderName: sender.senderName,
    senderAddress: sender.senderAddress,
    mailboxName: displayMailboxName,
    mailboxUrl: displayMailboxUrl,
    provider,
    accountLabel: accountClassification.accountLabel,
    accountCategory: accountClassification.accountCategory,
    receivedAt: receivedAt ?? "",
    receivedAtLocal: receivedAtDate ? toLocalDateTimeString(receivedAtDate) : "",
    isUnread: true as boolean,
    messageUrl,
    source: SOURCE_NAME,
    ...(labels ? { labels } : {}),
  } satisfies NormalizedEmail
}

export const matchesMailboxFilter = (email: NormalizedEmail, mailbox: string | undefined) => {
  if (!mailbox) {
    return true
  }

  const normalizedFilter = mailbox.toLowerCase()
  return (
    email.mailboxName.toLowerCase().includes(normalizedFilter) ||
    email.mailboxUrl.toLowerCase().includes(normalizedFilter) ||
    // A Gmail message filed under several labels matches any of them.
    (email.labels ?? []).some((label) => label.toLowerCase().includes(normalizedFilter))
  )
}
