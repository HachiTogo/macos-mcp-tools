import { Database, type SQLQueryBindings } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

import { PACKAGE_VERSION } from "../lib/version"
import {
  FETCH_EMAIL_ATTACHMENT_JXA,
  FETCH_EMAIL_BODY_JXA,
  FETCH_EMAIL_SOURCE_JXA,
  FLAG_EMAILS_JXA,
  FORWARD_EMAIL_JXA,
  LIST_EMAIL_ATTACHMENTS_JXA,
  MARK_EMAILS_JUNK_JXA,
  MARK_EMAILS_NOT_JUNK_JXA,
  MARK_EMAILS_READ_JXA,
  REPLY_EMAIL_JXA,
  SEND_EMAIL_JXA,
} from "./mail/jxa-scripts"

type TableColumnRow = {
  name: string
}

type MailboxUrlRow = {
  mailboxUrl: string | null
}

type EmailRow = {
  documentId: string | null
  mailboxUrl: string | null
  messageIdText: string | null
  receivedAtUnix: number | null
  resolvedSenderAddress: string | null
  resolvedSenderName: string | null
  resolvedSubject: string | null
  rowIdText: string
  senderReferenceText: string | null
  subjectPrefix: string | null
  subjectReferenceText: string | null
  readFlag?: number | null
  messageIdHeader?: string | null
}

export type NormalizedEmail = {
  id: string
  handle: EmailHandle
  subject: string
  senderName: string
  senderAddress: string
  mailboxName: string
  mailboxUrl: string
  provider: "gmail" | "icloud"
  accountLabel: string
  accountCategory: string
  receivedAt: string
  receivedAtLocal: string
  isUnread: boolean
  messageUrl: string
  source: string
}

export type EmailHandle = {
  accountId: string
  mailboxUrl: string
  mailId: string
}

type AccountClassification = Pick<NormalizedEmail, "accountLabel" | "accountCategory">

type EmailAccountConfig = {
  label: string
  category: string
  provider: "gmail" | "icloud" | "unknown"
}

type EmailConfig = {
  accounts: Record<string, EmailAccountConfig>
  displayOrder: string[]
}

type EmailGroup = AccountClassification & {
  messages: NormalizedEmail[]
}

export type UnreadEmailArguments = {
  limit: number
  mailbox?: string
  provider?: "gmail" | "icloud"
}

export type SearchEmailArguments = {
  subject?: string
  sender?: string
  after?: string
  before?: string
  mailbox?: string
  provider?: "gmail" | "icloud"
  unreadOnly?: boolean
  limit: number
}

export type MarkEmailsReadArguments = {
  emails: MarkEmailsReadTarget[]
}

export type MarkEmailsReadTarget = {
  id: string
  subject?: string
  handle: EmailHandle
}

export type MarkEmailsReadResult = {
  id: string
  subject?: string
  handle: EmailHandle
  status: "marked_read" | "already_read" | "not_found" | "invalid_handle" | "error"
  detail?: string
}

export type FetchEmailBodyArguments = {
  handle: EmailHandle
}

export type FetchEmailBodyResult = {
  handle: EmailHandle
  body: string
  found: boolean
  truncated: boolean
}

export type ExtractEmailLinksArguments = {
  handle: EmailHandle
}

export type EmailLink = {
  url: string
  text: string
}

export type ExtractEmailLinksResult = {
  handle: EmailHandle
  found: boolean
  links: EmailLink[]
  count: number
  truncated: boolean
}

export type ListEmailAttachmentsArguments = {
  handle: EmailHandle
}

export type EmailAttachment = {
  name: string
  downloaded: boolean
}

export type ListEmailAttachmentsResult = {
  handle: EmailHandle
  found: boolean
  attachments: EmailAttachment[]
}

export type FetchEmailAttachmentArguments = {
  handle: EmailHandle
  attachmentName: string
  format: "text" | "base64"
}

export type FetchEmailAttachmentResult = {
  handle: EmailHandle
  name: string
  mimeType: string
  sizeBytes: number
  content: string
  format: "text" | "base64"
}

export type MarkEmailsJunkArguments = {
  emails: MarkEmailsJunkTarget[]
}

export type MarkEmailsJunkTarget = {
  id: string
  subject?: string
  handle: EmailHandle
}

export type MarkEmailsJunkResult = {
  id: string
  subject?: string
  handle: EmailHandle
  status: "marked_junk" | "already_junk" | "not_found" | "invalid_handle" | "no_junk_mailbox" | "error"
  detail?: string
}

export type MarkEmailsNotJunkArguments = {
  emails: MarkEmailsNotJunkTarget[]
}

export type MarkEmailsNotJunkTarget = {
  id: string
  subject?: string
  handle: EmailHandle
}

export type MarkEmailsNotJunkResult = {
  id: string
  subject?: string
  handle: EmailHandle
  status: "marked_not_junk" | "already_not_junk" | "not_found" | "invalid_handle" | "no_inbox_mailbox" | "error"
  detail?: string
}

export type FlagEmailsArguments = {
  emails: FlagEmailsTarget[]
}

export type FlagEmailsTarget = {
  id: string
  subject?: string
  handle: EmailHandle
  flagIndex?: number
  flaggedStatus?: boolean
  backgroundColor?: string
}

export type FlagEmailsResult = {
  id: string
  subject?: string
  handle: EmailHandle
  status: "flagged" | "not_found" | "invalid_handle" | "error"
  detail?: string
}

export type SendEmailArguments = {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
  from?: string
}

export type SendEmailResult = {
  status: "sent" | "error"
  detail?: string
  recipientCount?: number
}

export type ReplyEmailArguments = {
  handle: EmailHandle
  body: string
  replyAll?: boolean
  from?: string
}

export type ReplyEmailResult = {
  status: "sent" | "not_found" | "invalid_handle" | "error"
  detail?: string
}

export type ForwardEmailArguments = {
  handle: EmailHandle
  to: string[]
  cc?: string[]
  bcc?: string[]
  body?: string
  from?: string
}

export type ForwardEmailResult = {
  status: "sent" | "not_found" | "invalid_handle" | "error"
  detail?: string
  recipientCount?: number
}

type SchemaInfo = {
  addresses: Set<string>
  mailboxes: Set<string>
  messageGlobalData: Set<string>
  messages: Set<string>
  senderAddresses: Set<string>
  senders: Set<string>
  subjects: Set<string>
}

class EmailToolError extends Error {
  code: "read_failed"

  constructor(message: string) {
    super(message)
    this.name = "EmailToolError"
    this.code = "read_failed"
  }
}

const MAIL_DB_PATH = join(homedir(), "Library/Mail/V10/MailData/Envelope Index")
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
const READ_FETCH_LIMIT = 250
const BODY_MAX_CHARS = 8_000
const MAX_LINKS = 500
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "local"
const SOURCE_NAME = "Apple Mail Envelope Index"
const UNKNOWN_ACCOUNT_CLASSIFICATION = {
  accountLabel: "unknown",
  accountCategory: "unknown",
} as const satisfies AccountClassification

const CONFIG_PATH = resolve(import.meta.dir, "..", "..", "config", "email.json")

const EMPTY_CONFIG: EmailConfig = {
  accounts: {},
  displayOrder: [],
}

const loadEmailConfig = (): EmailConfig => {
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

const discoverAndWriteConfig = (database: Database): EmailConfig => {
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

const padNumber = (value: number) => String(value).padStart(2, "0")

const toLocalDateTimeString = (value: Date) =>
  `${value.getFullYear()}-${padNumber(value.getMonth() + 1)}-${padNumber(value.getDate())}T${padNumber(value.getHours())}:${padNumber(value.getMinutes())}:${padNumber(value.getSeconds())}`

const cleanText = (value: string | null | undefined) => {
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim()
  return normalized || undefined
}

const getColumns = (database: Database, tableName: string) => {
  try {
    const rows = database.query(`PRAGMA table_info(${tableName})`).all() as TableColumnRow[]
    return new Set(rows.map((row) => row.name))
  } catch {
    return new Set<string>()
  }
}

const getSchemaInfo = (database: Database): SchemaInfo => ({
  messages: getColumns(database, "messages"),
  messageGlobalData: getColumns(database, "message_global_data"),
  subjects: getColumns(database, "subjects"),
  addresses: getColumns(database, "addresses"),
  senders: getColumns(database, "senders"),
  senderAddresses: getColumns(database, "sender_addresses"),
  mailboxes: getColumns(database, "mailboxes"),
})

const ensureRequiredColumns = (schema: SchemaInfo) => {
  const requiredMessages = ["mailbox", "read", "deleted"]

  for (const column of requiredMessages) {
    if (!schema.messages.has(column)) {
      throw new EmailToolError(`Email read failed: missing messages.${column} in Envelope Index schema.`)
    }
  }

  if (!schema.mailboxes.has("url")) {
    throw new EmailToolError("Email read failed: missing mailboxes.url in Envelope Index schema.")
  }
}

const buildUnreadMessagesQuery = (schema: SchemaInfo) => {
  const canResolveSubject = schema.messages.has("subject") && schema.subjects.has("subject")
  const canResolveDirectSender = schema.messages.has("sender") && schema.addresses.has("address")
  const canJoinSenderLookup = schema.messages.has("sender") && schema.senders.size > 0
  const canResolveMappedSender =
    canJoinSenderLookup &&
    schema.senderAddresses.has("sender") &&
    schema.senderAddresses.has("address") &&
    schema.addresses.has("address")

  const canJoinMessageGlobalData =
    schema.messages.has("message_id") &&
    schema.messageGlobalData.has("message_id") &&
    schema.messageGlobalData.has("message_id_header")

  const joins = ["JOIN mailboxes ON mailboxes.ROWID = messages.mailbox"]

  if (canResolveSubject) {
    joins.push("LEFT JOIN subjects subject_lookup ON subject_lookup.ROWID = messages.subject")
  }

  if (canResolveDirectSender) {
    joins.push("LEFT JOIN addresses direct_sender ON direct_sender.ROWID = messages.sender")
  }

  if (canJoinSenderLookup) {
    joins.push("LEFT JOIN senders sender_lookup ON sender_lookup.ROWID = messages.sender")
  }

  if (canResolveMappedSender) {
    joins.push(
      "LEFT JOIN (SELECT sender, MIN(address) AS address FROM sender_addresses GROUP BY sender) sender_address_lookup ON sender_address_lookup.sender = sender_lookup.ROWID",
    )
    joins.push("LEFT JOIN addresses mapped_sender ON mapped_sender.ROWID = sender_address_lookup.address")
  }

  if (canJoinMessageGlobalData) {
    joins.push("LEFT JOIN message_global_data mgd ON mgd.message_id = messages.message_id")
  }

  const receivedAtExpression = schema.messages.has("date_received")
    ? "messages.date_received"
    : schema.messages.has("display_date")
      ? "messages.display_date"
      : "NULL"

  const documentIdExpression = schema.messages.has("document_id") ? "messages.document_id" : "NULL"
  const messageIdExpression = schema.messages.has("message_id") ? "CAST(messages.message_id AS TEXT)" : "NULL"
  const messageIdHeaderExpression = canJoinMessageGlobalData ? "mgd.message_id_header" : "NULL"
  const subjectReferenceExpression = schema.messages.has("subject") ? "CAST(messages.subject AS TEXT)" : "NULL"
  const subjectPrefixExpression = schema.messages.has("subject_prefix") ? "messages.subject_prefix" : "NULL"
  const senderReferenceExpression = schema.messages.has("sender") ? "CAST(messages.sender AS TEXT)" : "NULL"
  const resolvedSubjectExpression = canResolveSubject ? "subject_lookup.subject" : "NULL"

  const resolvedSenderNameParts = [
    canResolveDirectSender ? "NULLIF(TRIM(direct_sender.comment), '')" : undefined,
    canResolveMappedSender ? "NULLIF(TRIM(mapped_sender.comment), '')" : undefined,
    canJoinSenderLookup && schema.senders.has("contact_identifier")
      ? "NULLIF(TRIM(sender_lookup.contact_identifier), '')"
      : undefined,
  ].filter(Boolean)

  const resolvedSenderAddressParts = [
    canResolveDirectSender ? "NULLIF(TRIM(direct_sender.address), '')" : undefined,
    canResolveMappedSender ? "NULLIF(TRIM(mapped_sender.address), '')" : undefined,
  ].filter(Boolean)

  const resolvedSenderNameExpression =
    resolvedSenderNameParts.length > 0 ? `COALESCE(${resolvedSenderNameParts.join(", ")})` : "NULL"

  const resolvedSenderAddressExpression =
    resolvedSenderAddressParts.length > 0 ? `COALESCE(${resolvedSenderAddressParts.join(", ")})` : "NULL"

  return `
    SELECT
      CAST(messages.ROWID AS TEXT) AS rowIdText,
      ${messageIdExpression} AS messageIdText,
      ${documentIdExpression} AS documentId,
      ${receivedAtExpression} AS receivedAtUnix,
      ${resolvedSubjectExpression} AS resolvedSubject,
      ${subjectReferenceExpression} AS subjectReferenceText,
      ${subjectPrefixExpression} AS subjectPrefix,
      ${resolvedSenderNameExpression} AS resolvedSenderName,
      ${resolvedSenderAddressExpression} AS resolvedSenderAddress,
      ${senderReferenceExpression} AS senderReferenceText,
      mailboxes.url AS mailboxUrl,
      ${messageIdHeaderExpression} AS messageIdHeader
    FROM messages
    ${joins.join("\n    ")}
    WHERE messages.read = 0
      AND messages.deleted = 0
      AND mailboxes.url IS NOT NULL
      AND mailboxes.url NOT LIKE 'local://%'
    ORDER BY COALESCE(${receivedAtExpression}, 0) DESC, messages.ROWID DESC
    LIMIT ${READ_FETCH_LIMIT}
  `
}

const buildSearchMessagesQuery = (
  schema: SchemaInfo,
  args: SearchEmailArguments,
): { sql: string; params: SQLQueryBindings[] } => {
  const canResolveSubject = schema.messages.has("subject") && schema.subjects.has("subject")
  const canResolveDirectSender = schema.messages.has("sender") && schema.addresses.has("address")
  const canJoinSenderLookup = schema.messages.has("sender") && schema.senders.size > 0
  const canResolveMappedSender =
    canJoinSenderLookup &&
    schema.senderAddresses.has("sender") &&
    schema.senderAddresses.has("address") &&
    schema.addresses.has("address")
  const canJoinMessageGlobalData =
    schema.messages.has("message_id") &&
    schema.messageGlobalData.has("message_id") &&
    schema.messageGlobalData.has("message_id_header")

  const joins = ["JOIN mailboxes ON mailboxes.ROWID = messages.mailbox"]

  if (canResolveSubject) {
    joins.push("LEFT JOIN subjects subject_lookup ON subject_lookup.ROWID = messages.subject")
  }

  if (canResolveDirectSender) {
    joins.push("LEFT JOIN addresses direct_sender ON direct_sender.ROWID = messages.sender")
  }

  if (canJoinSenderLookup) {
    joins.push("LEFT JOIN senders sender_lookup ON sender_lookup.ROWID = messages.sender")
  }

  if (canResolveMappedSender) {
    joins.push(
      "LEFT JOIN (SELECT sender, MIN(address) AS address FROM sender_addresses GROUP BY sender) sender_address_lookup ON sender_address_lookup.sender = sender_lookup.ROWID",
    )
    joins.push("LEFT JOIN addresses mapped_sender ON mapped_sender.ROWID = sender_address_lookup.address")
  }

  if (canJoinMessageGlobalData) {
    joins.push("LEFT JOIN message_global_data mgd ON mgd.message_id = messages.message_id")
  }

  const receivedAtExpression = schema.messages.has("date_received")
    ? "messages.date_received"
    : schema.messages.has("display_date")
      ? "messages.display_date"
      : "NULL"

  const documentIdExpression = schema.messages.has("document_id") ? "messages.document_id" : "NULL"
  const messageIdExpression = schema.messages.has("message_id") ? "CAST(messages.message_id AS TEXT)" : "NULL"
  const messageIdHeaderExpression = canJoinMessageGlobalData ? "mgd.message_id_header" : "NULL"
  const subjectReferenceExpression = schema.messages.has("subject") ? "CAST(messages.subject AS TEXT)" : "NULL"
  const subjectPrefixExpression = schema.messages.has("subject_prefix") ? "messages.subject_prefix" : "NULL"
  const senderReferenceExpression = schema.messages.has("sender") ? "CAST(messages.sender AS TEXT)" : "NULL"
  const resolvedSubjectExpression = canResolveSubject ? "subject_lookup.subject" : "NULL"

  const resolvedSenderNameParts = [
    canResolveDirectSender ? "NULLIF(TRIM(direct_sender.comment), '')" : undefined,
    canResolveMappedSender ? "NULLIF(TRIM(mapped_sender.comment), '')" : undefined,
    canJoinSenderLookup && schema.senders.has("contact_identifier")
      ? "NULLIF(TRIM(sender_lookup.contact_identifier), '')"
      : undefined,
  ].filter(Boolean)

  const resolvedSenderAddressParts = [
    canResolveDirectSender ? "NULLIF(TRIM(direct_sender.address), '')" : undefined,
    canResolveMappedSender ? "NULLIF(TRIM(mapped_sender.address), '')" : undefined,
  ].filter(Boolean)

  const resolvedSenderNameExpression =
    resolvedSenderNameParts.length > 0 ? `COALESCE(${resolvedSenderNameParts.join(", ")})` : "NULL"

  const resolvedSenderAddressExpression =
    resolvedSenderAddressParts.length > 0 ? `COALESCE(${resolvedSenderAddressParts.join(", ")})` : "NULL"

  const params: SQLQueryBindings[] = []
  const whereClauses: string[] = [
    "messages.deleted = 0",
    "mailboxes.url IS NOT NULL",
    "mailboxes.url NOT LIKE 'local://%'",
  ]

  if (args.unreadOnly) {
    whereClauses.push("messages.read = 0")
  }

  if (args.subject) {
    const subjectParts: string[] = []
    if (canResolveSubject) {
      subjectParts.push("COALESCE(subject_lookup.subject, '') LIKE ?")
      params.push(`%${args.subject}%`)
    }
    if (schema.messages.has("subject_prefix")) {
      subjectParts.push("COALESCE(messages.subject_prefix, '') LIKE ?")
      params.push(`%${args.subject}%`)
    }
    if (subjectParts.length > 0) {
      whereClauses.push(`(${subjectParts.join(" OR ")})`)
    }
  }

  if (args.sender) {
    const senderParts: string[] = []
    if (canResolveDirectSender) {
      senderParts.push("COALESCE(direct_sender.address, '') LIKE ?")
      params.push(`%${args.sender}%`)
      senderParts.push("COALESCE(direct_sender.comment, '') LIKE ?")
      params.push(`%${args.sender}%`)
    }
    if (canResolveMappedSender) {
      senderParts.push("COALESCE(mapped_sender.address, '') LIKE ?")
      params.push(`%${args.sender}%`)
      senderParts.push("COALESCE(mapped_sender.comment, '') LIKE ?")
      params.push(`%${args.sender}%`)
    }
    if (senderParts.length > 0) {
      whereClauses.push(`(${senderParts.join(" OR ")})`)
    }
  }

  if (args.after) {
    whereClauses.push(`COALESCE(${receivedAtExpression}, 0) >= ?`)
    params.push(Math.floor(new Date(args.after).getTime() / 1000))
  }

  if (args.before) {
    whereClauses.push(`COALESCE(${receivedAtExpression}, 0) < ?`)
    params.push(Math.floor(new Date(args.before).getTime() / 1000))
  }

  const sql = `
    SELECT
      CAST(messages.ROWID AS TEXT) AS rowIdText,
      ${messageIdExpression} AS messageIdText,
      ${documentIdExpression} AS documentId,
      ${receivedAtExpression} AS receivedAtUnix,
      ${resolvedSubjectExpression} AS resolvedSubject,
      ${subjectReferenceExpression} AS subjectReferenceText,
      ${subjectPrefixExpression} AS subjectPrefix,
      ${resolvedSenderNameExpression} AS resolvedSenderName,
      ${resolvedSenderAddressExpression} AS resolvedSenderAddress,
      ${senderReferenceExpression} AS senderReferenceText,
      mailboxes.url AS mailboxUrl,
      messages.read AS readFlag,
      ${messageIdHeaderExpression} AS messageIdHeader
    FROM messages
    ${joins.join("\n    ")}
    WHERE ${whereClauses.join("\n      AND ")}
    ORDER BY COALESCE(${receivedAtExpression}, 0) DESC, messages.ROWID DESC
    LIMIT ${READ_FETCH_LIMIT}
  `

  return { sql, params }
}

export const getMailboxAccountKey = (mailboxUrl: string) => mailboxUrl.match(/^[a-z]+:\/\/([^/]+)/i)?.[1] ?? mailboxUrl

export const createEmailHandle = (mailboxUrl: string, mailId: string): EmailHandle => ({
  accountId: getMailboxAccountKey(mailboxUrl),
  mailboxUrl,
  mailId,
})

const decodeMailboxPath = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const getMailboxName = (mailboxUrl: string) => {
  const match = mailboxUrl.match(/^[a-z]+:\/\/[^/]+\/(.+)$/i)
  return decodeMailboxPath(match?.[1] ?? mailboxUrl)
}

const getProviderByAccount = (config: EmailConfig): Map<string, "gmail" | "icloud"> => {
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

const toIsoStringFromUnixSeconds = (value: number | null) => {
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

const buildMessageUrl = (messageIdHeader: string | null | undefined): string => {
  if (!messageIdHeader) return ""
  const trimmed = messageIdHeader.trim()
  if (!trimmed) return ""
  // message_id_header is stored with angle brackets: <id@domain>
  // message: URL format: message:%3Cid@domain%3E
  const bare = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed
  if (!bare) return ""
  return `message:%3C${bare}%3E`
}

const isEmailLike = (value: string | undefined) => Boolean(value?.includes("@"))

const normalizeSubject = (row: EmailRow) => {
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

const normalizeSender = (row: EmailRow) => {
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

// Mailbox names are "/"-separated paths (see getMailboxName). A mailbox is excluded when any
// segment starts with one of these names, so both top-level "Junk" and nested "[Gmail]/Spam" match.
const EXCLUDED_MAILBOX_SEGMENTS = [
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

const normalizeEmail = (row: EmailRow, providerByAccount: Map<string, "gmail" | "icloud">, config: EmailConfig) => {
  const mailboxUrl = cleanText(row.mailboxUrl) ?? ""

  if (!mailboxUrl) {
    return undefined
  }

  const mailboxName = getMailboxName(mailboxUrl)
  const accountKey = getMailboxAccountKey(mailboxUrl)
  const provider = providerByAccount.get(accountKey) ?? "icloud"

  if (isExcludedMailbox(mailboxUrl, mailboxName, provider)) {
    return undefined
  }

  const displayMailboxName =
    provider === "gmail" && mailboxName.toLowerCase().includes("all mail") ? "INBOX" : mailboxName
  const messageId = cleanText(row.messageIdText) ?? ""
  const accountClassification = classifyAccountByMailboxUrl(mailboxUrl, config)
  const receivedAt = toIsoStringFromUnixSeconds(row.receivedAtUnix)
  const receivedAtDate = receivedAt ? new Date(receivedAt) : undefined
  const sender = normalizeSender(row)
  const messageUrl = buildMessageUrl(row.messageIdHeader)

  return {
    id: messageId || cleanText(row.documentId) || row.rowIdText,
    handle: createEmailHandle(mailboxUrl, row.rowIdText),
    subject: normalizeSubject(row),
    senderName: sender.senderName,
    senderAddress: sender.senderAddress,
    mailboxName: displayMailboxName,
    mailboxUrl,
    provider,
    accountLabel: accountClassification.accountLabel,
    accountCategory: accountClassification.accountCategory,
    receivedAt: receivedAt ?? "",
    receivedAtLocal: receivedAtDate ? toLocalDateTimeString(receivedAtDate) : "",
    isUnread: true as boolean,
    messageUrl,
    source: SOURCE_NAME,
  } satisfies NormalizedEmail
}

const matchesMailboxFilter = (email: NormalizedEmail, mailbox: string | undefined) => {
  if (!mailbox) {
    return true
  }

  const normalizedFilter = mailbox.toLowerCase()
  return (
    email.mailboxName.toLowerCase().includes(normalizedFilter) ||
    email.mailboxUrl.toLowerCase().includes(normalizedFilter)
  )
}

const formatEmailLine = (email: NormalizedEmail, index: number) => {
  const sender = email.senderName || email.senderAddress || "Unknown sender"
  const mailbox = email.mailboxName || email.mailboxUrl
  const receivedAt = email.receivedAtLocal || email.receivedAt || "unknown time"
  return `${index + 1}. [${receivedAt}] ${sender} — ${email.subject} (${mailbox})`
}

export const groupEmailsByAccount = (emails: NormalizedEmail[], config: EmailConfig) => {
  const groups = new Map<string, EmailGroup>()

  for (const email of emails) {
    const key = `${email.accountLabel}:${email.accountCategory}`
    const existing = groups.get(key)

    if (existing) {
      existing.messages.push(email)
      continue
    }

    groups.set(key, {
      accountLabel: email.accountLabel,
      accountCategory: email.accountCategory,
      messages: [email],
    })
  }

  const order = config.displayOrder
  // Labels missing from displayOrder sort after configured ones, alphabetically. A finite sentinel
  // avoids Infinity - Infinity = NaN, which made the sort unspecified whenever displayOrder was empty.
  const rank = (label: string) => {
    const index = order.indexOf(label)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }
  return [...groups.values()].sort(
    (left, right) =>
      rank(left.accountLabel) - rank(right.accountLabel) || left.accountLabel.localeCompare(right.accountLabel),
  )
}

export const formatEmailsForContent = (
  emails: NormalizedEmail[],
  argumentsValue: UnreadEmailArguments,
  config: EmailConfig,
) => {
  const summaryParts = [`Found ${emails.length} unread email${emails.length === 1 ? "" : "s"}`]

  if (argumentsValue.provider) {
    summaryParts.push(`for ${argumentsValue.provider}`)
  }

  if (argumentsValue.mailbox) {
    summaryParts.push(`matching mailbox "${argumentsValue.mailbox}"`)
  }

  const groupedSections = groupEmailsByAccount(emails, config).map((group) => {
    const heading = `${group.accountLabel} (${group.accountCategory}) — ${group.messages.length} unread`
    const lines = group.messages.map(formatEmailLine)
    return `${heading}\n${lines.join("\n")}`
  })
  const json = JSON.stringify(emails, null, 2)

  if (groupedSections.length === 0) {
    return `${summaryParts.join(" ")}.\n\n[]`
  }

  return `${summaryParts.join(" ")}.\n\n${groupedSections.join("\n\n")}\n\n${json}`
}

const getRequiredArray = (value: Record<string, unknown>, key: string) => {
  const item = value[key]

  if (!Array.isArray(item)) {
    throw new Error(`Invalid ${key}: expected an array.`)
  }

  return item
}

const getMarkEmailHandle = (value: Record<string, unknown>) => {
  const handleValue = value.handle

  if (!handleValue || typeof handleValue !== "object" || Array.isArray(handleValue)) {
    throw new Error("Invalid email: expected a handle object.")
  }

  return {
    accountId: getOptionalString(handleValue as Record<string, unknown>, "accountId") ?? "",
    mailboxUrl: getOptionalString(handleValue as Record<string, unknown>, "mailboxUrl") ?? "",
    mailId: getOptionalString(handleValue as Record<string, unknown>, "mailId") ?? "",
  }
}

export const parseMarkEmailsReadArguments = (value: unknown): MarkEmailsReadArguments => {
  const objectValue = validateArgumentsObject(value, ["emails"])
  const emails = getRequiredArray(objectValue, "emails")

  if (emails.length === 0) {
    throw new Error("Invalid emails: expected at least one email.")
  }

  return {
    emails: emails.map((emailValue, index) => {
      if (!emailValue || typeof emailValue !== "object" || Array.isArray(emailValue)) {
        throw new Error(`Invalid emails[${index}]: expected an object.`)
      }

      const email = emailValue as Record<string, unknown>

      return {
        id: getOptionalString(email, "id") ?? `email-${index + 1}`,
        subject: getOptionalString(email, "subject"),
        handle: getMarkEmailHandle(email),
      }
    }),
  }
}

export const parseFetchEmailBodyArguments = (value: unknown): FetchEmailBodyArguments => {
  const objectValue = validateArgumentsObject(value, ["handle"])
  const handleValue = objectValue.handle

  if (!handleValue || typeof handleValue !== "object" || Array.isArray(handleValue)) {
    throw new Error("Invalid handle: expected an object.")
  }

  const handle = handleValue as Record<string, unknown>
  const accountId = getOptionalString(handle, "accountId") ?? ""
  const mailboxUrl = getOptionalString(handle, "mailboxUrl") ?? ""
  const mailId = getOptionalString(handle, "mailId") ?? ""

  if (!accountId || !mailboxUrl || !mailId) {
    throw new Error("Invalid handle: accountId, mailboxUrl, and mailId are required.")
  }

  return {
    handle: { accountId, mailboxUrl, mailId },
  }
}

export const parseExtractEmailLinksArguments = (value: unknown): ExtractEmailLinksArguments => {
  const objectValue = validateArgumentsObject(value, ["handle"])
  const handleValue = objectValue.handle

  if (!handleValue || typeof handleValue !== "object" || Array.isArray(handleValue)) {
    throw new Error("Invalid handle: expected an object.")
  }

  const handle = handleValue as Record<string, unknown>
  const accountId = getOptionalString(handle, "accountId") ?? ""
  const mailboxUrl = getOptionalString(handle, "mailboxUrl") ?? ""
  const mailId = getOptionalString(handle, "mailId") ?? ""

  if (!accountId || !mailboxUrl || !mailId) {
    throw new Error("Invalid handle: accountId, mailboxUrl, and mailId are required.")
  }

  return {
    handle: { accountId, mailboxUrl, mailId },
  }
}

export const parseListEmailAttachmentsArguments = (value: unknown): ListEmailAttachmentsArguments => {
  const objectValue = validateArgumentsObject(value, ["handle"])
  const handleValue = objectValue.handle

  if (!handleValue || typeof handleValue !== "object" || Array.isArray(handleValue)) {
    throw new Error("Invalid handle: expected an object.")
  }

  const handle = handleValue as Record<string, unknown>
  const accountId = getOptionalString(handle, "accountId") ?? ""
  const mailboxUrl = getOptionalString(handle, "mailboxUrl") ?? ""
  const mailId = getOptionalString(handle, "mailId") ?? ""

  if (!accountId || !mailboxUrl || !mailId) {
    throw new Error("Invalid handle: accountId, mailboxUrl, and mailId are required.")
  }

  return {
    handle: { accountId, mailboxUrl, mailId },
  }
}

export const parseFetchEmailAttachmentArguments = (value: unknown): FetchEmailAttachmentArguments => {
  const objectValue = validateArgumentsObject(value, ["handle", "attachmentName", "format"])
  const handleValue = objectValue.handle

  if (!handleValue || typeof handleValue !== "object" || Array.isArray(handleValue)) {
    throw new Error("Invalid handle: expected an object.")
  }

  const handle = handleValue as Record<string, unknown>
  const accountId = getOptionalString(handle, "accountId") ?? ""
  const mailboxUrl = getOptionalString(handle, "mailboxUrl") ?? ""
  const mailId = getOptionalString(handle, "mailId") ?? ""

  if (!accountId || !mailboxUrl || !mailId) {
    throw new Error("Invalid handle: accountId, mailboxUrl, and mailId are required.")
  }

  const attachmentName = getOptionalString(objectValue, "attachmentName")
  if (!attachmentName) {
    throw new Error("Invalid attachmentName: expected a non-empty string.")
  }

  const formatRaw = getOptionalString(objectValue, "format")
  if (formatRaw && formatRaw !== "text" && formatRaw !== "base64") {
    throw new Error('Invalid format: expected "text" or "base64".')
  }
  const format: "text" | "base64" = formatRaw === "base64" ? "base64" : "text"

  return {
    handle: { accountId, mailboxUrl, mailId },
    attachmentName,
    format,
  }
}

export const parseMarkEmailsJunkArguments = (value: unknown): MarkEmailsJunkArguments => {
  const objectValue = validateArgumentsObject(value, ["emails"])
  const emails = getRequiredArray(objectValue, "emails")

  if (emails.length === 0) {
    throw new Error("Invalid emails: expected at least one email.")
  }

  return {
    emails: emails.map((emailValue, index) => {
      if (!emailValue || typeof emailValue !== "object" || Array.isArray(emailValue)) {
        throw new Error(`Invalid emails[${index}]: expected an object.`)
      }

      const email = emailValue as Record<string, unknown>

      return {
        id: getOptionalString(email, "id") ?? `email-${index + 1}`,
        subject: getOptionalString(email, "subject"),
        handle: getMarkEmailHandle(email),
      }
    }),
  }
}

export const parseMarkEmailsNotJunkArguments = (value: unknown): MarkEmailsNotJunkArguments => {
  const objectValue = validateArgumentsObject(value, ["emails"])
  const emails = getRequiredArray(objectValue, "emails")

  if (emails.length === 0) {
    throw new Error("Invalid emails: expected at least one email.")
  }

  return {
    emails: emails.map((emailValue, index) => {
      if (!emailValue || typeof emailValue !== "object" || Array.isArray(emailValue)) {
        throw new Error(`Invalid emails[${index}]: expected an object.`)
      }

      const email = emailValue as Record<string, unknown>

      return {
        id: getOptionalString(email, "id") ?? `email-${index + 1}`,
        subject: getOptionalString(email, "subject"),
        handle: getMarkEmailHandle(email),
      }
    }),
  }
}

export const parseFlagEmailsArguments = (value: unknown): FlagEmailsArguments => {
  const objectValue = validateArgumentsObject(value, ["emails"])
  const emails = getRequiredArray(objectValue, "emails")

  if (emails.length === 0) {
    throw new Error("Invalid emails: expected at least one email.")
  }

  return {
    emails: emails.map((emailValue, index) => {
      if (!emailValue || typeof emailValue !== "object" || Array.isArray(emailValue)) {
        throw new Error(`Invalid emails[${index}]: expected an object.`)
      }

      const email = emailValue as Record<string, unknown>

      const result: FlagEmailsTarget = {
        id: getOptionalString(email, "id") ?? `email-${index + 1}`,
        subject: getOptionalString(email, "subject"),
        handle: getMarkEmailHandle(email),
      }

      if (typeof email.flagIndex === "number") {
        result.flagIndex = email.flagIndex
      }

      if (typeof email.flaggedStatus === "boolean") {
        result.flaggedStatus = email.flaggedStatus
      }

      if (typeof email.backgroundColor === "string") {
        result.backgroundColor = email.backgroundColor
      }

      return result
    }),
  }
}

const EMAIL_ADDRESS_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_EMAIL_BODY_LENGTH = 1_000_000

const validateEmailArray = (value: unknown, fieldName: string, options: { allowEmpty: boolean }): string[] => {
  if (value === undefined || value === null) {
    if (options.allowEmpty) return []
    throw new Error(`Invalid ${fieldName}: expected a non-empty array of email addresses.`)
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an array of email addresses.`)
  }

  if (!options.allowEmpty && value.length === 0) {
    throw new Error(`Invalid ${fieldName}: expected at least one email address.`)
  }

  const result: string[] = []
  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    if (typeof item !== "string" || !EMAIL_ADDRESS_REGEX.test(item)) {
      throw new Error(`Invalid ${fieldName}[${i}]: expected a valid email address.`)
    }
    result.push(item)
  }
  return result
}

const validateHandleObject = (value: unknown): EmailHandle => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid handle: expected an object.")
  }

  const handle = value as Record<string, unknown>
  const accountId = getOptionalString(handle, "accountId") ?? ""
  const mailboxUrl = getOptionalString(handle, "mailboxUrl") ?? ""
  const mailId = getOptionalString(handle, "mailId") ?? ""

  if (!accountId || !mailboxUrl || !mailId) {
    throw new Error("Invalid handle: accountId, mailboxUrl, and mailId are required.")
  }

  return { accountId, mailboxUrl, mailId }
}

export const parseSendEmailArguments = (value: unknown): SendEmailArguments => {
  const objectValue = validateArgumentsObject(value, ["to", "cc", "bcc", "subject", "body", "from"])

  const to = validateEmailArray(objectValue.to, "to", { allowEmpty: false })
  const cc = objectValue.cc === undefined ? undefined : validateEmailArray(objectValue.cc, "cc", { allowEmpty: true })
  const bcc =
    objectValue.bcc === undefined ? undefined : validateEmailArray(objectValue.bcc, "bcc", { allowEmpty: true })

  const subject = getOptionalString(objectValue, "subject")
  if (!subject) {
    throw new Error("Invalid subject: expected a non-empty string.")
  }

  const body = getOptionalString(objectValue, "body")
  if (!body) {
    throw new Error("Invalid body: expected a non-empty string.")
  }
  if (body.length > MAX_EMAIL_BODY_LENGTH) {
    throw new Error(`Invalid body: must be at most ${MAX_EMAIL_BODY_LENGTH} characters.`)
  }

  const from = getOptionalString(objectValue, "from")
  if (from !== undefined && !EMAIL_ADDRESS_REGEX.test(from)) {
    throw new Error("Invalid from: expected a valid email address.")
  }

  return {
    to,
    ...(cc !== undefined ? { cc } : {}),
    ...(bcc !== undefined ? { bcc } : {}),
    subject,
    body,
    ...(from !== undefined ? { from } : {}),
  }
}

export const parseReplyEmailArguments = (value: unknown): ReplyEmailArguments => {
  const objectValue = validateArgumentsObject(value, ["handle", "body", "replyAll", "from"])

  const handle = validateHandleObject(objectValue.handle)

  const body = getOptionalString(objectValue, "body")
  if (!body) {
    throw new Error("Invalid body: expected a non-empty string.")
  }
  if (body.length > MAX_EMAIL_BODY_LENGTH) {
    throw new Error(`Invalid body: must be at most ${MAX_EMAIL_BODY_LENGTH} characters.`)
  }

  let replyAll: boolean | undefined
  if (objectValue.replyAll !== undefined) {
    if (typeof objectValue.replyAll !== "boolean") {
      throw new Error("Invalid replyAll: expected a boolean.")
    }
    replyAll = objectValue.replyAll
  }

  const from = getOptionalString(objectValue, "from")
  if (from !== undefined && !EMAIL_ADDRESS_REGEX.test(from)) {
    throw new Error("Invalid from: expected a valid email address.")
  }

  return {
    handle,
    body,
    ...(replyAll !== undefined ? { replyAll } : {}),
    ...(from !== undefined ? { from } : {}),
  }
}

export const parseForwardEmailArguments = (value: unknown): ForwardEmailArguments => {
  const objectValue = validateArgumentsObject(value, ["handle", "to", "cc", "bcc", "body", "from"])

  const handle = validateHandleObject(objectValue.handle)

  const to = validateEmailArray(objectValue.to, "to", { allowEmpty: false })
  const cc = objectValue.cc === undefined ? undefined : validateEmailArray(objectValue.cc, "cc", { allowEmpty: true })
  const bcc =
    objectValue.bcc === undefined ? undefined : validateEmailArray(objectValue.bcc, "bcc", { allowEmpty: true })

  const body = getOptionalString(objectValue, "body")
  if (body !== undefined && body.length > MAX_EMAIL_BODY_LENGTH) {
    throw new Error(`Invalid body: must be at most ${MAX_EMAIL_BODY_LENGTH} characters.`)
  }

  const from = getOptionalString(objectValue, "from")
  if (from !== undefined && !EMAIL_ADDRESS_REGEX.test(from)) {
    throw new Error("Invalid from: expected a valid email address.")
  }

  return {
    handle,
    to,
    ...(cc !== undefined ? { cc } : {}),
    ...(bcc !== undefined ? { bcc } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(from !== undefined ? { from } : {}),
  }
}

export const formatSendEmailSummary = (result: SendEmailResult) => {
  if (result.status === "sent") {
    if (typeof result.recipientCount === "number") {
      return `Sent: ${result.recipientCount} recipient${result.recipientCount === 1 ? "" : "s"}.`
    }
    return "Sent."
  }
  return `send_email failed: ${result.detail ?? "unknown error"}`
}

export const formatReplyEmailSummary = (result: ReplyEmailResult) => {
  switch (result.status) {
    case "sent":
      return "Reply sent."
    case "not_found":
      return `reply_email failed: ${result.detail ?? "Original message not found."}`
    case "invalid_handle":
      return `reply_email failed: ${result.detail ?? "Invalid handle."}`
    default:
      return `reply_email failed: ${result.detail ?? "unknown error"}`
  }
}

export const formatForwardEmailSummary = (result: ForwardEmailResult) => {
  switch (result.status) {
    case "sent":
      if (typeof result.recipientCount === "number") {
        return `Forward sent: ${result.recipientCount} recipient${result.recipientCount === 1 ? "" : "s"}.`
      }
      return "Forward sent."
    case "not_found":
      return `forward_email failed: ${result.detail ?? "Original message not found."}`
    case "invalid_handle":
      return `forward_email failed: ${result.detail ?? "Invalid handle."}`
    default:
      return `forward_email failed: ${result.detail ?? "unknown error"}`
  }
}

export const formatMarkEmailsReadSummary = (results: MarkEmailsReadResult[]) => {
  const counts = {
    markedRead: 0,
    alreadyRead: 0,
    notFound: 0,
    invalidHandle: 0,
    error: 0,
  }

  for (const result of results) {
    switch (result.status) {
      case "marked_read":
        counts.markedRead += 1
        break
      case "already_read":
        counts.alreadyRead += 1
        break
      case "not_found":
        counts.notFound += 1
        break
      case "invalid_handle":
        counts.invalidHandle += 1
        break
      case "error":
        counts.error += 1
        break
    }
  }

  const parts = [`Processed ${results.length} email${results.length === 1 ? "" : "s"}`]

  if (counts.markedRead > 0) {
    parts.push(`${counts.markedRead} marked read`)
  }

  if (counts.alreadyRead > 0) {
    parts.push(`${counts.alreadyRead} already read`)
  }

  if (counts.notFound > 0) {
    parts.push(`${counts.notFound} not found`)
  }

  if (counts.invalidHandle > 0) {
    parts.push(`${counts.invalidHandle} invalid handle`)
  }

  if (counts.error > 0) {
    parts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`)
  }

  return `${parts.join("; ")}.`
}

export const formatMarkEmailsJunkSummary = (results: MarkEmailsJunkResult[]) => {
  const counts = {
    markedJunk: 0,
    alreadyJunk: 0,
    notFound: 0,
    invalidHandle: 0,
    noJunkMailbox: 0,
    error: 0,
  }

  for (const result of results) {
    switch (result.status) {
      case "marked_junk":
        counts.markedJunk += 1
        break
      case "already_junk":
        counts.alreadyJunk += 1
        break
      case "not_found":
        counts.notFound += 1
        break
      case "invalid_handle":
        counts.invalidHandle += 1
        break
      case "no_junk_mailbox":
        counts.noJunkMailbox += 1
        break
      case "error":
        counts.error += 1
        break
    }
  }

  const parts = [`Processed ${results.length} email${results.length === 1 ? "" : "s"}`]

  if (counts.markedJunk > 0) {
    parts.push(`${counts.markedJunk} marked junk`)
  }

  if (counts.alreadyJunk > 0) {
    parts.push(`${counts.alreadyJunk} already junk`)
  }

  if (counts.notFound > 0) {
    parts.push(`${counts.notFound} not found`)
  }

  if (counts.invalidHandle > 0) {
    parts.push(`${counts.invalidHandle} invalid handle`)
  }

  if (counts.noJunkMailbox > 0) {
    parts.push(`${counts.noJunkMailbox} no junk mailbox`)
  }

  if (counts.error > 0) {
    parts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`)
  }

  return `${parts.join("; ")}.`
}

export const formatMarkEmailsNotJunkSummary = (results: MarkEmailsNotJunkResult[]) => {
  const counts = {
    markedNotJunk: 0,
    alreadyNotJunk: 0,
    notFound: 0,
    invalidHandle: 0,
    noInboxMailbox: 0,
    error: 0,
  }

  for (const result of results) {
    switch (result.status) {
      case "marked_not_junk":
        counts.markedNotJunk += 1
        break
      case "already_not_junk":
        counts.alreadyNotJunk += 1
        break
      case "not_found":
        counts.notFound += 1
        break
      case "invalid_handle":
        counts.invalidHandle += 1
        break
      case "no_inbox_mailbox":
        counts.noInboxMailbox += 1
        break
      case "error":
        counts.error += 1
        break
    }
  }

  const parts = [`Processed ${results.length} email${results.length === 1 ? "" : "s"}`]

  if (counts.markedNotJunk > 0) {
    parts.push(`${counts.markedNotJunk} marked not junk`)
  }

  if (counts.alreadyNotJunk > 0) {
    parts.push(`${counts.alreadyNotJunk} already not junk`)
  }

  if (counts.notFound > 0) {
    parts.push(`${counts.notFound} not found`)
  }

  if (counts.invalidHandle > 0) {
    parts.push(`${counts.invalidHandle} invalid handle`)
  }

  if (counts.noInboxMailbox > 0) {
    parts.push(`${counts.noInboxMailbox} no inbox mailbox`)
  }

  if (counts.error > 0) {
    parts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`)
  }

  return `${parts.join("; ")}.`
}

export const formatFlagEmailsSummary = (results: FlagEmailsResult[]) => {
  const counts = {
    flagged: 0,
    notFound: 0,
    invalidHandle: 0,
    error: 0,
  }

  for (const result of results) {
    switch (result.status) {
      case "flagged":
        counts.flagged += 1
        break
      case "not_found":
        counts.notFound += 1
        break
      case "invalid_handle":
        counts.invalidHandle += 1
        break
      case "error":
        counts.error += 1
        break
    }
  }

  const parts = [`Processed ${results.length} email${results.length === 1 ? "" : "s"}`]

  if (counts.flagged > 0) {
    parts.push(`${counts.flagged} flagged`)
  }

  if (counts.notFound > 0) {
    parts.push(`${counts.notFound} not found`)
  }

  if (counts.invalidHandle > 0) {
    parts.push(`${counts.invalidHandle} invalid handle`)
  }

  if (counts.error > 0) {
    parts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`)
  }

  return `${parts.join("; ")}.`
}

const getOptionalString = (value: Record<string, unknown>, key: string) => {
  const item = value[key]

  if (item === undefined) {
    return undefined
  }

  if (typeof item !== "string") {
    throw new Error(`Invalid ${key}: expected a string.`)
  }

  const normalized = item.trim()

  if (!normalized) {
    throw new Error(`Invalid ${key}: expected a non-empty string.`)
  }

  return normalized
}

const getOptionalLimit = (value: Record<string, unknown>) => {
  const item = value.limit

  if (item === undefined || item === null) {
    return DEFAULT_LIMIT
  }

  if (typeof item !== "number" || !Number.isInteger(item)) {
    throw new Error("Invalid limit: expected an integer.")
  }

  if (item < 1 || item > MAX_LIMIT) {
    throw new Error(`Invalid limit: expected a value between 1 and ${MAX_LIMIT}.`)
  }

  return item
}

// TODO: remove redundant validation — SDK handles this via Zod schema
const validateArgumentsObject = (value: unknown, allowedKeys: string[]) => {
  if (value === undefined) {
    return {}
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid arguments: expected an object.")
  }

  const keys = Object.keys(value)

  for (const key of keys) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`Invalid arguments: unexpected field "${key}".`)
    }
  }

  return value as Record<string, unknown>
}

const parseUnreadEmailArguments = (value: unknown): UnreadEmailArguments => {
  const objectValue = validateArgumentsObject(value, ["limit", "mailbox", "provider"])
  const provider = getOptionalString(objectValue, "provider") as "gmail" | "icloud" | undefined

  if (provider && provider !== "gmail" && provider !== "icloud") {
    throw new Error('Invalid provider: expected "gmail" or "icloud".')
  }

  return {
    limit: getOptionalLimit(objectValue),
    mailbox: getOptionalString(objectValue, "mailbox"),
    provider,
  }
}

const parseSearchEmailArguments = (value: unknown): SearchEmailArguments => {
  const objectValue = validateArgumentsObject(value, [
    "subject",
    "sender",
    "after",
    "before",
    "mailbox",
    "provider",
    "unreadOnly",
    "limit",
  ])
  const subject = getOptionalString(objectValue, "subject")
  const sender = getOptionalString(objectValue, "sender")
  const after = getOptionalString(objectValue, "after")
  const before = getOptionalString(objectValue, "before")
  const mailbox = getOptionalString(objectValue, "mailbox")
  const providerRaw = getOptionalString(objectValue, "provider")
  const unreadOnly = objectValue.unreadOnly === true
  const limit = getOptionalLimit(objectValue)

  if (!subject && !sender && !after && !before) {
    throw new Error("At least one of 'subject', 'sender', 'after', or 'before' is required.")
  }

  let provider: "gmail" | "icloud" | undefined
  if (providerRaw) {
    const lower = providerRaw.toLowerCase()
    if (lower !== "gmail" && lower !== "icloud") {
      throw new Error(`Invalid provider '${providerRaw}'. Must be 'gmail' or 'icloud'.`)
    }
    provider = lower as "gmail" | "icloud"
  }

  if (after && Number.isNaN(Date.parse(after))) {
    throw new Error(`Invalid 'after' date: '${after}'. Use ISO 8601 format.`)
  }
  if (before && Number.isNaN(Date.parse(before))) {
    throw new Error(`Invalid 'before' date: '${before}'. Use ISO 8601 format.`)
  }

  return { subject, sender, after, before, mailbox, provider, unreadOnly, limit }
}

const markEmailsReadWithJxa = (targets: MarkEmailsReadTarget[]) => {
  const command = spawnSync(
    "osascript",
    ["-l", "JavaScript", "-e", MARK_EMAILS_READ_JXA, "--", JSON.stringify({ targets })],
    {
      encoding: "utf8",
    },
  )

  if (command.error) {
    throw command.error
  }

  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `osascript failed with exit code ${command.status}.`)
  }

  const output = JSON.parse(command.stdout || "{}") as {
    results?: MarkEmailsReadResult[]
  }

  if (!Array.isArray(output.results)) {
    throw new Error("Mail mark read failed: invalid JXA response.")
  }

  return output.results
}

const fetchEmailBodyWithJxa = (handle: EmailHandle): { found: boolean; body: string } => {
  const command = spawnSync(
    "osascript",
    ["-l", "JavaScript", "-e", FETCH_EMAIL_BODY_JXA, "--", JSON.stringify({ handle })],
    { encoding: "utf8" },
  )

  if (command.error) {
    throw command.error
  }

  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `osascript failed with exit code ${command.status}.`)
  }

  const output = JSON.parse(command.stdout || "{}") as { found?: boolean; body?: string }
  return {
    found: output.found === true,
    body: typeof output.body === "string" ? output.body : "",
  }
}

const createFetchEmailBodyResult = async (argumentsValue: FetchEmailBodyArguments) => {
  try {
    const { found, body } = fetchEmailBodyWithJxa(argumentsValue.handle)
    const truncated = body.length > BODY_MAX_CHARS
    const trimmedBody = truncated ? body.slice(0, BODY_MAX_CHARS) : body

    const result: FetchEmailBodyResult = {
      handle: argumentsValue.handle,
      body: trimmedBody,
      found,
      truncated,
    }

    return {
      content: [
        {
          type: "text",
          text: found ? trimmedBody : "(message not found)",
        },
      ],
      structuredContent: result,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      content: [{ type: "text", text: `fetch_email_body failed: ${detail}` }],
      structuredContent: {
        handle: argumentsValue.handle,
        body: "",
        found: false,
        truncated: false,
      },
      isError: true,
    }
  }
}

const fetchEmailSourceWithJxa = (handle: EmailHandle): { found: boolean; source: string } => {
  const command = spawnSync(
    "osascript",
    ["-l", "JavaScript", "-e", FETCH_EMAIL_SOURCE_JXA, "--", JSON.stringify({ handle })],
    { encoding: "utf8" },
  )

  if (command.error) {
    throw command.error
  }

  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `osascript failed with exit code ${command.status}.`)
  }

  const output = JSON.parse(command.stdout || "{}") as { found?: boolean; source?: string }
  return {
    found: output.found === true,
    source: typeof output.source === "string" ? output.source : "",
  }
}

const decodeQuotedPrintable = (value: string): string => {
  const softBreaksRemoved = value.replace(/=\r?\n/g, "")
  return softBreaksRemoved.replace(/=([0-9A-Fa-f]{2})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
}

const decodeBase64Body = (value: string): string => {
  const stripped = value.replace(/\s+/g, "")
  try {
    return Buffer.from(stripped, "base64").toString("utf8")
  } catch {
    return ""
  }
}

const decodeHtmlEntities = (value: string): string => {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(parseInt(dec, 10)))
}

const findMimePart = (source: string, contentTypePattern: RegExp): { body: string; encoding: string } | null => {
  const typeMatch = contentTypePattern.exec(source)
  if (!typeMatch) {
    return null
  }

  const partStart = typeMatch.index
  const blankLineMatch = /\r?\n\r?\n/.exec(source.slice(partStart))
  if (!blankLineMatch) {
    return null
  }
  const bodyStart = partStart + blankLineMatch.index + blankLineMatch[0].length

  const headers = source.slice(partStart, partStart + blankLineMatch.index)
  const encodingMatch = /Content-Transfer-Encoding\s*:\s*([^\r\n;]+)/i.exec(headers)
  const encoding = encodingMatch ? encodingMatch[1].trim().toLowerCase() : ""

  const remainder = source.slice(bodyStart)
  const boundaryMatch = /\r?\n--/.exec(remainder)
  const body = boundaryMatch ? remainder.slice(0, boundaryMatch.index) : remainder

  return { body, encoding }
}

const decodePartBody = (body: string, encoding: string): string => {
  if (encoding === "quoted-printable") {
    return decodeQuotedPrintable(body)
  }
  if (encoding === "base64") {
    return decodeBase64Body(body)
  }
  return body
}

export const extractLinksFromSource = (source: string): { links: EmailLink[]; truncated: boolean } => {
  const htmlPart = findMimePart(source, /Content-Type\s*:\s*text\/html/i)
  const links: EmailLink[] = []
  const seen = new Set<string>()

  const pushLink = (url: string, text: string) => {
    const key = `${url}\t${text}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    links.push({ url, text })
  }

  if (htmlPart) {
    const html = decodePartBody(htmlPart.body, htmlPart.encoding)
    const anchorRegex = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi
    for (const match of html.matchAll(anchorRegex)) {
      const href = (match[1] ?? match[2] ?? match[3] ?? "").trim()
      if (!href) continue
      if (href.startsWith("mailto:")) continue
      if (href.startsWith("javascript:")) continue
      if (href.startsWith("#")) continue

      const innerRaw = match[4] ?? ""
      const stripped = innerRaw.replace(/<[^>]*>/g, "")
      const decoded = decodeHtmlEntities(stripped)
      const text = decoded.replace(/\s+/g, " ").trim()

      pushLink(href, text)
    }
  } else {
    const plainPart = findMimePart(source, /Content-Type\s*:\s*text\/plain/i)
    const haystack = plainPart ? decodePartBody(plainPart.body, plainPart.encoding) : source
    const urlRegex = /\bhttps?:\/\/[^\s<>"']+/g
    for (const match of haystack.matchAll(urlRegex)) {
      const url = match[0]
      pushLink(url, url)
    }
  }

  if (links.length > MAX_LINKS) {
    return { links: links.slice(0, MAX_LINKS), truncated: true }
  }
  return { links, truncated: false }
}

const createExtractEmailLinksResult = async (argumentsValue: ExtractEmailLinksArguments) => {
  try {
    const { found, source } = fetchEmailSourceWithJxa(argumentsValue.handle)
    const { links, truncated } = found ? extractLinksFromSource(source) : { links: [] as EmailLink[], truncated: false }

    const result: ExtractEmailLinksResult = {
      handle: argumentsValue.handle,
      found,
      links,
      count: links.length,
      truncated,
    }

    const content = (() => {
      if (!found) {
        return [{ type: "text", text: "(message not found)" }]
      }
      if (links.length === 0) {
        return [{ type: "text", text: "No links found." }]
      }
      const header = `Found ${links.length} link${links.length === 1 ? "" : "s"}${truncated ? " (truncated)" : ""}`
      const lines = links.map((link) => `- [${link.text}](${link.url})`)
      return [{ type: "text", text: header }, ...lines.map((line) => ({ type: "text", text: line }))]
    })()

    return {
      content,
      structuredContent: result,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      content: [{ type: "text", text: `extract_email_links failed: ${detail}` }],
      structuredContent: {
        handle: argumentsValue.handle,
        found: false,
        links: [],
        count: 0,
        truncated: false,
      },
      isError: true,
    }
  }
}

const listEmailAttachmentsWithJxa = (handle: EmailHandle): { found: boolean; attachments: EmailAttachment[] } => {
  const command = spawnSync(
    "osascript",
    ["-l", "JavaScript", "-e", LIST_EMAIL_ATTACHMENTS_JXA, "--", JSON.stringify({ handle })],
    { encoding: "utf8" },
  )

  if (command.error) {
    throw command.error
  }

  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `osascript failed with exit code ${command.status}.`)
  }

  const output = JSON.parse(command.stdout || "{}") as { found?: boolean; attachments?: EmailAttachment[] }
  return {
    found: output.found === true,
    attachments: Array.isArray(output.attachments) ? output.attachments : [],
  }
}

const createListEmailAttachmentsResult = async (argumentsValue: ListEmailAttachmentsArguments) => {
  try {
    const { found, attachments } = listEmailAttachmentsWithJxa(argumentsValue.handle)

    const result: ListEmailAttachmentsResult = {
      handle: argumentsValue.handle,
      found,
      attachments,
    }

    const summary = found
      ? attachments.length === 0
        ? "No attachments found."
        : `Found ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}: ${attachments.map((a) => a.name).join(", ")}`
      : "(message not found)"

    return {
      content: [{ type: "text", text: summary }],
      structuredContent: result,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      content: [{ type: "text", text: `list_email_attachments failed: ${detail}` }],
      structuredContent: {
        handle: argumentsValue.handle,
        found: false,
        attachments: [],
      },
      isError: true,
    }
  }
}

const createFetchEmailAttachmentResult = async (argumentsValue: FetchEmailAttachmentArguments) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "mcp-mail-attachments-"))
  const tmpFilePath = join(tmpDir, argumentsValue.attachmentName)

  try {
    const command = spawnSync(
      "osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        FETCH_EMAIL_ATTACHMENT_JXA,
        "--",
        JSON.stringify({
          handle: argumentsValue.handle,
          attachmentName: argumentsValue.attachmentName,
          savePath: tmpFilePath,
        }),
      ],
      { encoding: "utf8" },
    )

    if (command.error) {
      throw command.error
    }

    if (command.status !== 0) {
      throw new Error(command.stderr.trim() || `osascript failed with exit code ${command.status}.`)
    }

    const jxaOutput = JSON.parse(command.stdout || "{}") as { saved?: boolean; error?: string }

    if (!jxaOutput.saved) {
      throw new Error(jxaOutput.error ?? "Failed to save attachment.")
    }

    const mimeResult = spawnSync("file", ["--mime-type", "-b", tmpFilePath], { encoding: "utf8" })
    const mimeType = mimeResult.stdout.trim() || "application/octet-stream"

    const sizeBytes = statSync(tmpFilePath).size

    let content: string
    let format: "text" | "base64"

    if (argumentsValue.format === "text" && mimeType === "application/pdf") {
      const pdfResult = spawnSync("pdftotext", [tmpFilePath, "-"], { encoding: "utf8" })
      if (pdfResult.error && (pdfResult.error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("pdftotext not found; install with: brew install poppler")
      }
      if (pdfResult.status !== 0) {
        throw new Error(pdfResult.stderr.trim() || "pdftotext failed.")
      }
      content = pdfResult.stdout
      format = "text"
    } else if (argumentsValue.format === "text" && mimeType.startsWith("text/")) {
      content = readFileSync(tmpFilePath, "utf8")
      format = "text"
    } else {
      content = readFileSync(tmpFilePath).toString("base64")
      format = "base64"
    }

    const result: FetchEmailAttachmentResult = {
      handle: argumentsValue.handle,
      name: argumentsValue.attachmentName,
      mimeType,
      sizeBytes,
      content,
      format,
    }

    return {
      content: [{ type: "text", text: content }],
      structuredContent: result,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      content: [{ type: "text", text: `fetch_email_attachment failed: ${detail}` }],
      structuredContent: {
        handle: argumentsValue.handle,
        name: argumentsValue.attachmentName,
        mimeType: "",
        sizeBytes: 0,
        content: "",
        format: argumentsValue.format,
      },
      isError: true,
    }
  } finally {
    try {
      rmSync(tmpDir, { recursive: true })
    } catch {
      // Non-fatal cleanup failure
    }
  }
}

const runUnreadEmailRead = (database: Database, argumentsValue: UnreadEmailArguments) => {
  const schema = getSchemaInfo(database)
  ensureRequiredColumns(schema)

  let config = loadEmailConfig()
  if (Object.keys(config.accounts).length === 0) {
    config = discoverAndWriteConfig(database)
  }

  const providerByAccount = getProviderByAccount(config)
  const query = buildUnreadMessagesQuery(schema)
  const rows = database.query(query).all() as EmailRow[]
  const emails = rows
    .map((row) => normalizeEmail(row, providerByAccount, config))
    .filter((row): row is NormalizedEmail => Boolean(row))
    .filter((row) => (argumentsValue.provider ? row.provider === argumentsValue.provider : true))
    .filter((row) => matchesMailboxFilter(row, argumentsValue.mailbox))
    .slice(0, argumentsValue.limit)

  // Surface unconfigured accounts
  const allAccountKeys = new Set(
    rows.map((row) => getMailboxAccountKey(cleanText(row.mailboxUrl) ?? "")).filter(Boolean),
  )
  const unconfiguredKeys = [...allAccountKeys].filter((key) => !config.accounts[key])
  const warnings: string[] = []
  if (unconfiguredKeys.length > 0) {
    warnings.push(
      `⚠️ ${unconfiguredKeys.length} unconfigured account(s): ${unconfiguredKeys.join(", ")}. Edit config/email.json to classify them.`,
    )
  }

  return {
    content: [
      {
        type: "text",
        text:
          (warnings.length > 0 ? `${warnings.join("\n")}\n\n` : "") +
          formatEmailsForContent(emails, argumentsValue, config),
      },
    ],
    structuredContent: {
      source: SOURCE_NAME,
      query: {
        limit: argumentsValue.limit,
        ...(argumentsValue.provider ? { provider: argumentsValue.provider } : {}),
        ...(argumentsValue.mailbox ? { mailbox: argumentsValue.mailbox } : {}),
        timeZone: TIME_ZONE,
      },
      messages: emails,
    },
  }
}

const createUnreadEmailsResult = async (argumentsValue: UnreadEmailArguments) => {
  let database: Database | undefined

  try {
    database = new Database(MAIL_DB_PATH, { readonly: true })
    return runUnreadEmailRead(database, argumentsValue)
  } catch (error) {
    const message =
      error instanceof EmailToolError
        ? error.message
        : `Email read failed: ${error instanceof Error ? error.message : String(error)}`

    return {
      content: [
        {
          type: "text",
          text: message,
        },
      ],
      structuredContent: {
        source: SOURCE_NAME,
        query: {
          limit: argumentsValue.limit,
          ...(argumentsValue.provider ? { provider: argumentsValue.provider } : {}),
          ...(argumentsValue.mailbox ? { mailbox: argumentsValue.mailbox } : {}),
          timeZone: TIME_ZONE,
        },
        messages: [],
      },
      isError: true,
    }
  } finally {
    database?.close(false)
  }
}

const formatSearchEmailSummary = (emails: NormalizedEmail[], args: SearchEmailArguments): string => {
  const criteria: string[] = []
  if (args.subject) criteria.push(`subject contains "${args.subject}"`)
  if (args.sender) criteria.push(`sender contains "${args.sender}"`)
  if (args.after) criteria.push(`after ${args.after}`)
  if (args.before) criteria.push(`before ${args.before}`)
  if (args.mailbox) criteria.push(`mailbox "${args.mailbox}"`)
  if (args.provider) criteria.push(`provider: ${args.provider}`)
  if (args.unreadOnly) criteria.push("unread only")

  const header = `Found ${emails.length} email(s) matching: ${criteria.join(", ")}`

  if (emails.length === 0) return header

  const lines = emails.map((e, i) => {
    const date = e.receivedAtLocal || e.receivedAt || "unknown date"
    const read = e.isUnread ? "unread" : "read"
    return `${i + 1}. [${date}] [${read}] ${e.senderName || e.senderAddress || "unknown"}: ${e.subject || "(no subject)"}`
  })

  return `${header}\n\n${lines.join("\n")}`
}

const createSearchEmailResult = async (args: SearchEmailArguments) => {
  let database: Database | undefined

  try {
    database = new Database(MAIL_DB_PATH, { readonly: true })
    const schema = getSchemaInfo(database)
    ensureRequiredColumns(schema)

    let config = loadEmailConfig()
    if (Object.keys(config.accounts).length === 0) {
      config = discoverAndWriteConfig(database)
    }

    const providerByAccount = getProviderByAccount(config)
    const { sql, params } = buildSearchMessagesQuery(schema, args)
    const rows = database.query(sql).all(...params) as (EmailRow & { readFlag?: number | null })[]
    const emails = rows
      .map((row) => {
        const normalized = normalizeEmail(row, providerByAccount, config)
        if (!normalized) return undefined
        // Override isUnread based on actual read flag from query
        normalized.isUnread = row.readFlag === 0
        return normalized
      })
      .filter((row): row is NormalizedEmail => Boolean(row))
      .filter((row) => (args.provider ? row.provider === args.provider : true))
      .filter((row) => matchesMailboxFilter(row, args.mailbox))
      .slice(0, args.limit)

    return {
      content: [
        {
          type: "text",
          text: formatSearchEmailSummary(emails, args),
        },
      ],
      structuredContent: {
        source: SOURCE_NAME,
        query: {
          limit: args.limit,
          ...(args.provider ? { provider: args.provider } : {}),
          ...(args.mailbox ? { mailbox: args.mailbox } : {}),
          ...(args.subject ? { subject: args.subject } : {}),
          ...(args.sender ? { sender: args.sender } : {}),
          ...(args.after ? { after: args.after } : {}),
          ...(args.before ? { before: args.before } : {}),
          ...(args.unreadOnly ? { unreadOnly: args.unreadOnly } : {}),
          timeZone: TIME_ZONE,
        },
        messages: emails,
      },
    }
  } catch (error) {
    const message =
      error instanceof EmailToolError
        ? error.message
        : `Email search failed: ${error instanceof Error ? error.message : String(error)}`

    return {
      content: [
        {
          type: "text",
          text: message,
        },
      ],
      structuredContent: {
        source: SOURCE_NAME,
        query: {
          limit: args.limit,
          timeZone: TIME_ZONE,
        },
        messages: [],
      },
      isError: true,
    }
  } finally {
    database?.close(false)
  }
}

// Per-item statuses that mean nothing was changed for that email. A batch result is an error only when
// every item failed; partial success is reported through the per-item statuses instead.
const FAILED_BATCH_STATUSES: ReadonlySet<string> = new Set([
  "not_found",
  "invalid_handle",
  "error",
  "no_junk_mailbox",
  "no_inbox_mailbox",
])

export const isBatchFailure = (results: ReadonlyArray<{ status: string }>) =>
  results.length > 0 && results.every((result) => FAILED_BATCH_STATUSES.has(result.status))

const createMarkEmailsReadResult = async (argumentsValue: MarkEmailsReadArguments) => {
  try {
    const results = markEmailsReadWithJxa(argumentsValue.emails)

    return {
      content: [
        {
          type: "text",
          text: formatMarkEmailsReadSummary(results),
        },
      ],
      structuredContent: {
        results,
      },
      ...(isBatchFailure(results) ? { isError: true } : {}),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const results: MarkEmailsReadResult[] = argumentsValue.emails.map((email) => ({
      id: email.id,
      subject: email.subject,
      handle: email.handle,
      status: "error",
      detail,
    }))

    return {
      content: [
        {
          type: "text",
          text: formatMarkEmailsReadSummary(results),
        },
      ],
      structuredContent: {
        results,
      },
      isError: true,
    }
  }
}

const markEmailsJunkWithJxa = (targets: MarkEmailsJunkTarget[]) => {
  const command = spawnSync(
    "osascript",
    ["-l", "JavaScript", "-e", MARK_EMAILS_JUNK_JXA, "--", JSON.stringify({ targets })],
    {
      encoding: "utf8",
    },
  )

  if (command.error) {
    throw command.error
  }

  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `osascript failed with exit code ${command.status}.`)
  }

  const output = JSON.parse(command.stdout || "{}") as {
    results?: MarkEmailsJunkResult[]
  }

  if (!Array.isArray(output.results)) {
    throw new Error("Mail mark junk failed: invalid JXA response.")
  }

  return output.results
}

const markEmailsNotJunkWithJxa = (targets: MarkEmailsNotJunkTarget[]) => {
  const command = spawnSync(
    "osascript",
    ["-l", "JavaScript", "-e", MARK_EMAILS_NOT_JUNK_JXA, "--", JSON.stringify({ targets })],
    {
      encoding: "utf8",
    },
  )

  if (command.error) {
    throw command.error
  }

  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `osascript failed with exit code ${command.status}.`)
  }

  const output = JSON.parse(command.stdout || "{}") as {
    results?: MarkEmailsNotJunkResult[]
  }

  if (!Array.isArray(output.results)) {
    throw new Error("Mail mark not-junk failed: invalid JXA response.")
  }

  return output.results
}

const flagEmailsWithJxa = (targets: FlagEmailsTarget[]) => {
  const command = spawnSync(
    "osascript",
    ["-l", "JavaScript", "-e", FLAG_EMAILS_JXA, "--", JSON.stringify({ targets })],
    {
      encoding: "utf8",
    },
  )

  if (command.error) {
    throw command.error
  }

  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `osascript failed with exit code ${command.status}.`)
  }

  const output = JSON.parse(command.stdout || "{}") as {
    results?: FlagEmailsResult[]
  }

  if (!Array.isArray(output.results)) {
    throw new Error("Mail flag emails failed: invalid JXA response.")
  }

  return output.results
}

const createMarkEmailsJunkResult = async (argumentsValue: MarkEmailsJunkArguments) => {
  try {
    const results = markEmailsJunkWithJxa(argumentsValue.emails)

    return {
      content: [
        {
          type: "text",
          text: formatMarkEmailsJunkSummary(results),
        },
      ],
      structuredContent: {
        results,
      },
      ...(isBatchFailure(results) ? { isError: true } : {}),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const results: MarkEmailsJunkResult[] = argumentsValue.emails.map((email) => ({
      id: email.id,
      subject: email.subject,
      handle: email.handle,
      status: "error",
      detail,
    }))

    return {
      content: [
        {
          type: "text",
          text: formatMarkEmailsJunkSummary(results),
        },
      ],
      structuredContent: {
        results,
      },
      isError: true,
    }
  }
}

const createMarkEmailsNotJunkResult = async (argumentsValue: MarkEmailsNotJunkArguments) => {
  try {
    const results = markEmailsNotJunkWithJxa(argumentsValue.emails)

    return {
      content: [
        {
          type: "text",
          text: formatMarkEmailsNotJunkSummary(results),
        },
      ],
      structuredContent: {
        results,
      },
      ...(isBatchFailure(results) ? { isError: true } : {}),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const results: MarkEmailsNotJunkResult[] = argumentsValue.emails.map((email) => ({
      id: email.id,
      subject: email.subject,
      handle: email.handle,
      status: "error",
      detail,
    }))

    return {
      content: [
        {
          type: "text",
          text: formatMarkEmailsNotJunkSummary(results),
        },
      ],
      structuredContent: {
        results,
      },
      isError: true,
    }
  }
}

const createFlagEmailsResult = async (argumentsValue: FlagEmailsArguments) => {
  try {
    const results = flagEmailsWithJxa(argumentsValue.emails)

    return {
      content: [
        {
          type: "text",
          text: formatFlagEmailsSummary(results),
        },
      ],
      structuredContent: {
        results,
      },
      ...(isBatchFailure(results) ? { isError: true } : {}),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const results: FlagEmailsResult[] = argumentsValue.emails.map((email) => ({
      id: email.id,
      subject: email.subject,
      handle: email.handle,
      status: "error",
      detail,
    }))

    return {
      content: [
        {
          type: "text",
          text: formatFlagEmailsSummary(results),
        },
      ],
      structuredContent: {
        results,
      },
      isError: true,
    }
  }
}

const sendEmailWithJxa = (args: SendEmailArguments): SendEmailResult => {
  const command = spawnSync("osascript", ["-l", "JavaScript", "-e", SEND_EMAIL_JXA, "--", JSON.stringify(args)], {
    encoding: "utf8",
  })

  if (command.error) {
    throw command.error
  }

  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `osascript failed with exit code ${command.status}.`)
  }

  const output = JSON.parse(command.stdout || "{}") as SendEmailResult
  if (output.status !== "sent" && output.status !== "error") {
    throw new Error("send_email: invalid JXA response.")
  }
  return output
}

const replyEmailWithJxa = (args: ReplyEmailArguments): ReplyEmailResult => {
  const command = spawnSync("osascript", ["-l", "JavaScript", "-e", REPLY_EMAIL_JXA, "--", JSON.stringify(args)], {
    encoding: "utf8",
  })

  if (command.error) {
    throw command.error
  }

  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `osascript failed with exit code ${command.status}.`)
  }

  const output = JSON.parse(command.stdout || "{}") as ReplyEmailResult
  return output
}

const forwardEmailWithJxa = (args: ForwardEmailArguments): ForwardEmailResult => {
  const command = spawnSync("osascript", ["-l", "JavaScript", "-e", FORWARD_EMAIL_JXA, "--", JSON.stringify(args)], {
    encoding: "utf8",
  })

  if (command.error) {
    throw command.error
  }

  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `osascript failed with exit code ${command.status}.`)
  }

  const output = JSON.parse(command.stdout || "{}") as ForwardEmailResult
  return output
}

const createSendEmailResult = async (argumentsValue: SendEmailArguments) => {
  try {
    const result = sendEmailWithJxa(argumentsValue)
    return {
      content: [
        {
          type: "text",
          text: formatSendEmailSummary(result),
        },
      ],
      structuredContent: result,
      ...(result.status === "error" ? { isError: true } : {}),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const result: SendEmailResult = { status: "error", detail }
    return {
      content: [{ type: "text", text: formatSendEmailSummary(result) }],
      structuredContent: result,
      isError: true,
    }
  }
}

const createReplyEmailResult = async (argumentsValue: ReplyEmailArguments) => {
  try {
    const result = replyEmailWithJxa(argumentsValue)
    return {
      content: [
        {
          type: "text",
          text: formatReplyEmailSummary(result),
        },
      ],
      structuredContent: result,
      ...(result.status !== "sent" ? { isError: true } : {}),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const result: ReplyEmailResult = { status: "error", detail }
    return {
      content: [{ type: "text", text: formatReplyEmailSummary(result) }],
      structuredContent: result,
      isError: true,
    }
  }
}

const createForwardEmailResult = async (argumentsValue: ForwardEmailArguments) => {
  try {
    const result = forwardEmailWithJxa(argumentsValue)
    return {
      content: [
        {
          type: "text",
          text: formatForwardEmailSummary(result),
        },
      ],
      structuredContent: result,
      ...(result.status !== "sent" ? { isError: true } : {}),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const result: ForwardEmailResult = { status: "error", detail }
    return {
      content: [{ type: "text", text: formatForwardEmailSummary(result) }],
      structuredContent: result,
      isError: true,
    }
  }
}

// ── Shared Zod schemas ─────────────────────────────────────────────────

const handleSchema = z.object({
  accountId: z.string(),
  mailboxUrl: z.string(),
  mailId: z.string(),
})

const emailsArraySchema = z
  .array(
    z.object({
      id: z.string(),
      subject: z.string().optional(),
      handle: handleSchema,
    }),
  )
  .min(1)

// ── MCP Server ─────────────────────────────────────────────────────────

const server = new McpServer({ name: "apple-mail", version: PACKAGE_VERSION })

server.registerTool(
  "unread_emails",
  {
    description: "Read unread Apple Mail messages without fetching bodies.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .default(DEFAULT_LIMIT)
        .optional()
        .describe("Maximum number of messages to return (1–100). Default: 25."),
      provider: z.enum(["gmail", "icloud"]).optional().describe("Filter to a specific email provider."),
      mailbox: z.string().optional().describe("Substring filter on mailbox name or URL (e.g. 'INBOX', 'work')."),
    },
  },
  async (args) => {
    const argumentsValue = parseUnreadEmailArguments(args)
    const result = await createUnreadEmailsResult(argumentsValue)
    return result as { content: { type: "text"; text: string }[]; isError?: boolean }
  },
)

server.registerTool(
  "mark_emails_read",
  {
    description:
      "Mark Apple Mail messages as read. Each item in 'emails' must be a full email object with 'id', 'subject', and 'handle' fields — pass the objects exactly as returned by unread_emails, not bare handle objects.",
    inputSchema: {
      emails: emailsArraySchema.describe("Array of email objects to mark as read."),
    },
  },
  async (args) => {
    const argumentsValue = parseMarkEmailsReadArguments(args)
    const result = await createMarkEmailsReadResult(argumentsValue)
    return result as { content: { type: "text"; text: string }[]; isError?: boolean }
  },
)

server.registerTool(
  "fetch_email_body",
  {
    description: "Fetch the full body text of a single Apple Mail message by its handle.",
    inputSchema: {
      handle: handleSchema.describe("Email handle identifying the message."),
    },
  },
  async (args) => {
    const argumentsValue = parseFetchEmailBodyArguments(args)
    const result = await createFetchEmailBodyResult(argumentsValue)
    return result as { content: { type: "text"; text: string }[]; isError?: boolean }
  },
)

server.registerTool(
  "extract_email_links",
  {
    description:
      "Extract all hyperlinks from an Apple Mail message as `{ url, text }` pairs. Reads the raw HTML source server-side (never returned to the caller) and returns just the link pairs. Use this when you need URLs for navigation, link auditing, or extracting actionable links from marketing emails.",
    inputSchema: {
      handle: handleSchema.describe("Email handle identifying the message."),
    },
  },
  async (args) => {
    const argumentsValue = parseExtractEmailLinksArguments(args)
    const result = await createExtractEmailLinksResult(argumentsValue)
    return result as { content: { type: "text"; text: string }[]; isError?: boolean }
  },
)

server.registerTool(
  "mark_emails_junk",
  {
    description:
      "Mark Apple Mail messages as junk/spam. Each item in 'emails' must be a full email object with 'id', 'subject', and 'handle' fields — pass the objects exactly as returned by unread_emails, not bare handle objects.",
    inputSchema: {
      emails: emailsArraySchema.describe("Array of email objects to mark as junk."),
    },
  },
  async (args) => {
    const argumentsValue = parseMarkEmailsJunkArguments(args)
    const result = await createMarkEmailsJunkResult(argumentsValue)
    return result as { content: { type: "text"; text: string }[]; isError?: boolean }
  },
)

server.registerTool(
  "mark_emails_not_junk",
  {
    description:
      "Mark Apple Mail messages as not junk. Each item in 'emails' must be a full email object with 'id', 'subject', and 'handle' fields — pass the objects exactly as returned by unread_emails, not bare handle objects.",
    inputSchema: {
      emails: emailsArraySchema.describe("Array of email objects to mark as not junk."),
    },
  },
  async (args) => {
    const argumentsValue = parseMarkEmailsNotJunkArguments(args)
    const result = await createMarkEmailsNotJunkResult(argumentsValue)
    return result as { content: { type: "text"; text: string }[]; isError?: boolean }
  },
)

server.registerTool(
  "flag_emails",
  {
    description:
      "Set flag color, flagged status, or background color on Apple Mail messages. Each item in 'emails' must include 'id', 'handle', and at least one of 'flagIndex', 'flaggedStatus', or 'backgroundColor'.",
    inputSchema: {
      emails: z
        .array(
          z.object({
            id: z.string(),
            subject: z.string().optional(),
            handle: handleSchema,
            flagIndex: z
              .number()
              .int()
              .min(-1)
              .max(6)
              .optional()
              .describe("Flag color index: -1=unflagged, 0=red, 1=orange, 2=yellow, 3=green, 4=blue, 5=purple, 6=gray"),
            flaggedStatus: z
              .boolean()
              .optional()
              .describe("Set flagged status directly. true=flagged, false=unflagged."),
            backgroundColor: z
              .enum(["blue", "gray", "green", "none", "orange", "purple", "red", "yellow"])
              .optional()
              .describe("Message background color in Mail.app."),
          }),
        )
        .min(1)
        .describe("Array of email objects to flag."),
    },
  },
  async (args) => {
    const argumentsValue = parseFlagEmailsArguments(args)
    const result = await createFlagEmailsResult(argumentsValue)
    return result as { content: { type: "text"; text: string }[]; isError?: boolean }
  },
)

server.registerTool(
  "list_email_attachments",
  {
    description: "Lists attachments on a message without downloading content.",
    inputSchema: {
      handle: handleSchema.describe("Email handle identifying the message."),
    },
  },
  async (args) => {
    const argumentsValue = parseListEmailAttachmentsArguments(args)
    const result = await createListEmailAttachmentsResult(argumentsValue)
    return result as { content: { type: "text"; text: string }[]; isError?: boolean }
  },
)

server.registerTool(
  "fetch_email_attachment",
  {
    description: "Downloads a single attachment and returns its content.",
    inputSchema: {
      handle: handleSchema.describe("Email handle identifying the message."),
      attachmentName: z.string().describe("Name of the attachment to fetch."),
      format: z
        .enum(["text", "base64"])
        .optional()
        .describe("Return format: 'text' for plain text / PDF extraction, 'base64' for binary. Defaults to 'text'."),
    },
  },
  async (args) => {
    const argumentsValue = parseFetchEmailAttachmentArguments(args)
    const result = await createFetchEmailAttachmentResult(argumentsValue)
    return result as { content: { type: "text"; text: string }[]; isError?: boolean }
  },
)

server.registerTool(
  "search_emails",
  {
    description:
      "Search emails by subject, sender, and/or date range. Returns matching emails from all accounts. At least one search criterion (subject, sender, after, before) is required.",
    inputSchema: {
      subject: z.string().optional().describe("Substring to match in the email subject line."),
      sender: z.string().optional().describe("Substring to match in the sender email address or display name."),
      after: z
        .string()
        .optional()
        .describe(
          "ISO 8601 date string. Only return emails received on or after this date. Example: '2025-01-15' or '2025-01-15T09:00:00Z'.",
        ),
      before: z
        .string()
        .optional()
        .describe("ISO 8601 date string. Only return emails received before this date. Example: '2025-03-01'."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .default(DEFAULT_LIMIT)
        .optional()
        .describe("Maximum number of results to return (1–100). Default: 25."),
      provider: z.enum(["gmail", "icloud"]).optional().describe("Filter to a specific email provider."),
      mailbox: z.string().optional().describe("Substring filter on mailbox name or URL (e.g. 'INBOX', 'work')."),
      unreadOnly: z.boolean().optional().describe("If true, only return unread emails. Defaults to false."),
    },
  },
  async (args) => {
    const argumentsValue = parseSearchEmailArguments(args)
    const result = await createSearchEmailResult(argumentsValue)
    return result as { content: { type: "text"; text: string }[]; isError?: boolean }
  },
)

server.registerTool(
  "send_email",
  {
    description:
      "Compose and send a new email via Apple Mail. Requires at least one 'to' recipient. Plain text body only.",
    inputSchema: {
      to: z.array(z.string().email()).min(1).describe("Recipient email addresses. At least one required."),
      cc: z.array(z.string().email()).optional().describe("CC recipient email addresses."),
      bcc: z.array(z.string().email()).optional().describe("BCC recipient email addresses."),
      subject: z.string().min(1).describe("Email subject line."),
      body: z.string().min(1).describe("Plain text email body."),
      from: z.string().email().optional().describe("Optional sender email address. Must match an enabled account."),
    },
  },
  async (args) => {
    const argumentsValue = parseSendEmailArguments(args)
    const result = await createSendEmailResult(argumentsValue)
    return result as { content: { type: "text"; text: string }[]; isError?: boolean }
  },
)

server.registerTool(
  "reply_email",
  {
    description: "Reply to an existing Apple Mail message by handle. Set replyAll=true to reply to all recipients.",
    inputSchema: {
      handle: handleSchema.describe("Email handle identifying the message being replied to."),
      body: z.string().min(1).describe("Plain text reply body. Prepended above the quoted original."),
      replyAll: z.boolean().optional().describe("If true, reply to all recipients of the original message."),
      from: z.string().email().optional().describe("Optional sender email address override."),
    },
  },
  async (args) => {
    const argumentsValue = parseReplyEmailArguments(args)
    const result = await createReplyEmailResult(argumentsValue)
    return result as { content: { type: "text"; text: string }[]; isError?: boolean }
  },
)

server.registerTool(
  "forward_email",
  {
    description: "Forward an existing Apple Mail message to new recipients.",
    inputSchema: {
      handle: handleSchema.describe("Email handle identifying the message being forwarded."),
      to: z.array(z.string().email()).min(1).describe("Recipient email addresses. At least one required."),
      cc: z.array(z.string().email()).optional().describe("CC recipient email addresses."),
      bcc: z.array(z.string().email()).optional().describe("BCC recipient email addresses."),
      body: z.string().optional().describe("Optional message to prepend above the forwarded content."),
      from: z.string().email().optional().describe("Optional sender email address override."),
    },
  },
  async (args) => {
    const argumentsValue = parseForwardEmailArguments(args)
    const result = await createForwardEmailResult(argumentsValue)
    return result as { content: { type: "text"; text: string }[]; isError?: boolean }
  },
)

// ── Entry point ────────────────────────────────────────────────────────

export const main = async () => {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// Boot only when executed directly; cli.ts and tests import this module without starting a server.
if (import.meta.main) {
  await main()
}
