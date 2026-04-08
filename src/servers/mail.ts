import { Database, SQLQueryBindings } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { homedir, tmpdir } from "node:os"
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync, mkdtempSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

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
  status:
    | "marked_not_junk"
    | "already_not_junk"
    | "not_found"
    | "invalid_handle"
    | "no_inbox_mailbox"
    | "error"
  detail?: string
}

type SchemaInfo = {
  addresses: Set<string>
  mailboxes: Set<string>
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
      accounts: parsed.accounts && typeof parsed.accounts === "object" ? parsed.accounts as Record<string, EmailAccountConfig> : {},
      displayOrder: Array.isArray(parsed.displayOrder) ? parsed.displayOrder : [],
    }
  } catch {
    return EMPTY_CONFIG
  }
}

const discoverAndWriteConfig = (database: Database): EmailConfig => {
  const mailboxRows = database.query("SELECT url AS mailboxUrl FROM mailboxes WHERE url IS NOT NULL").all() as MailboxUrlRow[]
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
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8")
  } catch {
    // Non-fatal: config write failure shouldn't break email reading
  }

  return config
}

const MARK_EMAILS_READ_JXA = String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")
  const targets = Array.isArray(input.targets) ? input.targets : []
  const decodeMailboxPart = (value) => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  const getMailboxName = (mailboxUrl) => mailboxUrl
    .replace(/^[a-z]+:\/\/[^/]+\//i, "")
    .split("/")
    .filter(Boolean)
    .map(decodeMailboxPart)
    .join("/")

  const results = targets.map((target) => {
    const baseResult = {
      id: target.id,
      subject: target.subject,
      handle: target.handle,
    }

    try {
      const handle = target.handle || {}
      const accountId = typeof handle.accountId === "string" ? handle.accountId : ""
      const mailboxUrl = typeof handle.mailboxUrl === "string" ? handle.mailboxUrl : ""
      const mailId = typeof handle.mailId === "string" ? handle.mailId : ""
      const mailboxName = getMailboxName(mailboxUrl)

      if (!accountId || !mailId || !mailboxName) {
        return {
          ...baseResult,
          status: "invalid_handle",
          detail: "Missing accountId, mailboxUrl, or mailId.",
        }
      }

      const account = Mail.accounts.byId(accountId)

      if (typeof account.exists === "function" && !account.exists()) {
        return {
          ...baseResult,
          status: "not_found",
        }
      }

      const mailbox = account.mailboxes.byName(mailboxName)

      if (typeof mailbox.exists === "function" && !mailbox.exists()) {
        return {
          ...baseResult,
          status: "not_found",
        }
      }

      const matchedMessage = mailbox.messages.byId(Number(mailId))

      if (typeof matchedMessage.exists === "function" && !matchedMessage.exists()) {
        return {
          ...baseResult,
          status: "not_found",
        }
      }

      if (matchedMessage.readStatus()) {
        return {
          ...baseResult,
          status: "already_read",
        }
      }

      matchedMessage.readStatus = true

      return {
        ...baseResult,
        status: "marked_read",
      }
    } catch (error) {
      return {
        ...baseResult,
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  })

  return JSON.stringify({ results })
}
`

const FETCH_EMAIL_BODY_JXA = String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")
  const handle = input.handle || {}
  const accountId = typeof handle.accountId === "string" ? handle.accountId : ""
  const mailboxUrl = typeof handle.mailboxUrl === "string" ? handle.mailboxUrl : ""
  const mailId = typeof handle.mailId === "string" ? handle.mailId : ""

  const decodeMailboxPart = (value) => {
    try { return decodeURIComponent(value) } catch { return value }
  }
  const getMailboxName = (url) => url
    .replace(/^[a-z]+:\/\/[^/]+\//i, "")
    .split("/")
    .filter(Boolean)
    .map(decodeMailboxPart)
    .join("/")

  if (!accountId || !mailId || !mailboxUrl) {
    return JSON.stringify({ found: false, body: "" })
  }

  try {
    const account = Mail.accounts.byId(accountId)
    if (typeof account.exists === "function" && !account.exists()) {
      return JSON.stringify({ found: false, body: "" })
    }
    const mailboxName = getMailboxName(mailboxUrl)
    const mailbox = account.mailboxes.byName(mailboxName)
    if (typeof mailbox.exists === "function" && !mailbox.exists()) {
      return JSON.stringify({ found: false, body: "" })
    }
    const message = mailbox.messages.byId(Number(mailId))
    if (typeof message.exists === "function" && !message.exists()) {
      return JSON.stringify({ found: false, body: "" })
    }
    const body = message.content() || ""
    return JSON.stringify({ found: true, body })
  } catch (error) {
    return JSON.stringify({ found: false, body: "", error: error instanceof Error ? error.message : String(error) })
  }
}
`

const LIST_EMAIL_ATTACHMENTS_JXA = String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")
  const handle = input.handle || {}
  const accountId = typeof handle.accountId === "string" ? handle.accountId : ""
  const mailboxUrl = typeof handle.mailboxUrl === "string" ? handle.mailboxUrl : ""
  const mailId = typeof handle.mailId === "string" ? handle.mailId : ""

  const decodeMailboxPart = (value) => {
    try { return decodeURIComponent(value) } catch { return value }
  }
  const getMailboxName = (url) => url
    .replace(/^[a-z]+:\/\/[^/]+\//i, "")
    .split("/")
    .filter(Boolean)
    .map(decodeMailboxPart)
    .join("/")

  if (!accountId || !mailId || !mailboxUrl) {
    return JSON.stringify({ found: false, attachments: [] })
  }

  try {
    const account = Mail.accounts.byId(accountId)
    if (typeof account.exists === "function" && !account.exists()) {
      return JSON.stringify({ found: false, attachments: [] })
    }
    const mailboxName = getMailboxName(mailboxUrl)
    const mailbox = account.mailboxes.byName(mailboxName)
    if (typeof mailbox.exists === "function" && !mailbox.exists()) {
      return JSON.stringify({ found: false, attachments: [] })
    }
    const message = mailbox.messages.byId(Number(mailId))
    if (typeof message.exists === "function" && !message.exists()) {
      return JSON.stringify({ found: false, attachments: [] })
    }
    const attachments = message.mailAttachments()
    const result = attachments.map((att) => ({
      name: att.name(),
      downloaded: att.downloaded(),
    }))
    return JSON.stringify({ found: true, attachments: result })
  } catch (error) {
    return JSON.stringify({ found: false, attachments: [], error: error instanceof Error ? error.message : String(error) })
  }
}
`

const FETCH_EMAIL_ATTACHMENT_JXA = String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")
  const handle = input.handle || {}
  const accountId = typeof handle.accountId === "string" ? handle.accountId : ""
  const mailboxUrl = typeof handle.mailboxUrl === "string" ? handle.mailboxUrl : ""
  const mailId = typeof handle.mailId === "string" ? handle.mailId : ""
  const attachmentName = typeof input.attachmentName === "string" ? input.attachmentName : ""
  const savePath = typeof input.savePath === "string" ? input.savePath : ""

  const decodeMailboxPart = (value) => {
    try { return decodeURIComponent(value) } catch { return value }
  }
  const getMailboxName = (url) => url
    .replace(/^[a-z]+:\/\/[^/]+\//i, "")
    .split("/")
    .filter(Boolean)
    .map(decodeMailboxPart)
    .join("/")

  if (!accountId || !mailId || !mailboxUrl || !attachmentName || !savePath) {
    return JSON.stringify({ saved: false, error: "Missing required parameters." })
  }

  try {
    const account = Mail.accounts.byId(accountId)
    if (typeof account.exists === "function" && !account.exists()) {
      return JSON.stringify({ saved: false, error: "Account not found." })
    }
    const mailboxName = getMailboxName(mailboxUrl)
    const mailbox = account.mailboxes.byName(mailboxName)
    if (typeof mailbox.exists === "function" && !mailbox.exists()) {
      return JSON.stringify({ saved: false, error: "Mailbox not found." })
    }
    const message = mailbox.messages.byId(Number(mailId))
    if (typeof message.exists === "function" && !message.exists()) {
      return JSON.stringify({ saved: false, error: "Message not found." })
    }
    const attachments = message.mailAttachments()
    let targetAttachment = null
    for (let i = 0; i < attachments.length; i++) {
      if (attachments[i].name() === attachmentName) {
        targetAttachment = attachments[i]
        break
      }
    }
    if (!targetAttachment) {
      return JSON.stringify({ saved: false, error: "Attachment '" + attachmentName + "' not found on message." })
    }
    if (!targetAttachment.downloaded()) {
      return JSON.stringify({ saved: false, error: "Attachment not downloaded; open message in Mail.app first." })
    }
    Mail.save(targetAttachment, { in: Path(savePath) })
    return JSON.stringify({ saved: true })
  } catch (error) {
    return JSON.stringify({ saved: false, error: error instanceof Error ? error.message : String(error) })
  }
}
`

const MARK_EMAILS_JUNK_JXA = String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")
  const targets = Array.isArray(input.targets) ? input.targets : []
  const decodeMailboxPart = (value) => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  const getMailboxName = (mailboxUrl) => mailboxUrl
    .replace(/^[a-z]+:\/\/[^/]+\//i, "")
    .split("/")
    .filter(Boolean)
    .map(decodeMailboxPart)
    .join("/")

  const junkNames = ["junk", "[gmail]/spam", "spam"]

  const findJunkMailbox = (account) => {
    const allMailboxes = account.mailboxes()
    for (const mb of allMailboxes) {
      try {
        const name = mb.name().toLowerCase()
        if (junkNames.includes(name)) return mb
      } catch {
        continue
      }
    }
    return null
  }

  const results = targets.map((target) => {
    const baseResult = {
      id: target.id,
      subject: target.subject,
      handle: target.handle,
    }

    try {
      const handle = target.handle || {}
      const accountId = typeof handle.accountId === "string" ? handle.accountId : ""
      const mailboxUrl = typeof handle.mailboxUrl === "string" ? handle.mailboxUrl : ""
      const mailId = typeof handle.mailId === "string" ? handle.mailId : ""
      const mailboxName = getMailboxName(mailboxUrl)

      if (!accountId || !mailId || !mailboxName) {
        return {
          ...baseResult,
          status: "invalid_handle",
          detail: "Missing accountId, mailboxUrl, or mailId.",
        }
      }

      const account = Mail.accounts.byId(accountId)

      if (typeof account.exists === "function" && !account.exists()) {
        return {
          ...baseResult,
          status: "not_found",
          detail: "Account not found.",
        }
      }

      const junkMailbox = findJunkMailbox(account)

      if (!junkMailbox) {
        return {
          ...baseResult,
          status: "no_junk_mailbox",
          detail: "No Junk or Spam mailbox found for this account.",
        }
      }

      const mailbox = account.mailboxes.byName(mailboxName)

      if (typeof mailbox.exists === "function" && !mailbox.exists()) {
        return {
          ...baseResult,
          status: "not_found",
          detail: "Mailbox not found.",
        }
      }

      const matchedMessage = mailbox.messages.byId(Number(mailId))

      if (typeof matchedMessage.exists === "function" && !matchedMessage.exists()) {
        return {
          ...baseResult,
          status: "not_found",
          detail: "Message not found.",
        }
      }

      const isAlreadyJunk = matchedMessage.junkMailStatus()
      const currentMailboxName = mailbox.name().toLowerCase()
      const isInJunkMailbox = junkNames.includes(currentMailboxName)

      if (isAlreadyJunk && isInJunkMailbox) {
        return {
          ...baseResult,
          status: "already_junk",
        }
      }

      matchedMessage.junkMailStatus = true
      Mail.move(matchedMessage, { to: junkMailbox })

      return {
        ...baseResult,
        status: "marked_junk",
      }
    } catch (error) {
      return {
        ...baseResult,
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  })

  return JSON.stringify({ results })
}
`

const MARK_EMAILS_NOT_JUNK_JXA = String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")
  const targets = Array.isArray(input.targets) ? input.targets : []
  const decodeMailboxPart = (value) => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  const getMailboxName = (mailboxUrl) => mailboxUrl
    .replace(/^[a-z]+:\/\/[^/]+\//i, "")
    .split("/")
    .filter(Boolean)
    .map(decodeMailboxPart)
    .join("/")

  const inboxNames = ["inbox"]

  const findInboxMailbox = (account) => {
    const allMailboxes = account.mailboxes()
    for (const mb of allMailboxes) {
      try {
        const name = mb.name().toLowerCase()
        if (inboxNames.includes(name)) return mb
      } catch {
        continue
      }
    }
    return null
  }

  const junkNames = ["junk", "[gmail]/spam", "spam"]

  const results = targets.map((target) => {
    const baseResult = {
      id: target.id,
      subject: target.subject,
      handle: target.handle,
    }

    try {
      const handle = target.handle || {}
      const accountId = typeof handle.accountId === "string" ? handle.accountId : ""
      const mailboxUrl = typeof handle.mailboxUrl === "string" ? handle.mailboxUrl : ""
      const mailId = typeof handle.mailId === "string" ? handle.mailId : ""
      const mailboxName = getMailboxName(mailboxUrl)

      if (!accountId || !mailId || !mailboxName) {
        return {
          ...baseResult,
          status: "invalid_handle",
          detail: "Missing accountId, mailboxUrl, or mailId.",
        }
      }

      const account = Mail.accounts.byId(accountId)

      if (typeof account.exists === "function" && !account.exists()) {
        return {
          ...baseResult,
          status: "not_found",
          detail: "Account not found.",
        }
      }

      const inboxMailbox = findInboxMailbox(account)

      if (!inboxMailbox) {
        return {
          ...baseResult,
          status: "no_inbox_mailbox",
          detail: "No Inbox mailbox found for this account.",
        }
      }

      const mailbox = account.mailboxes.byName(mailboxName)

      if (typeof mailbox.exists === "function" && !mailbox.exists()) {
        return {
          ...baseResult,
          status: "not_found",
          detail: "Mailbox not found.",
        }
      }

      const matchedMessage = mailbox.messages.byId(Number(mailId))

      if (typeof matchedMessage.exists === "function" && !matchedMessage.exists()) {
        return {
          ...baseResult,
          status: "not_found",
          detail: "Message not found.",
        }
      }

      const isJunk = matchedMessage.junkMailStatus()
      const currentMailboxName = mailbox.name().toLowerCase()
      const isInJunkMailbox = junkNames.includes(currentMailboxName)

      if (!isJunk && !isInJunkMailbox) {
        return {
          ...baseResult,
          status: "already_not_junk",
        }
      }

      matchedMessage.junkMailStatus = false
      Mail.move(matchedMessage, { to: inboxMailbox })

      return {
        ...baseResult,
        status: "marked_not_junk",
      }
    } catch (error) {
      return {
        ...baseResult,
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  })

  return JSON.stringify({ results })
}
`

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
    joins.push("LEFT JOIN (SELECT sender, MIN(address) AS address FROM sender_addresses GROUP BY sender) sender_address_lookup ON sender_address_lookup.sender = sender_lookup.ROWID")
    joins.push("LEFT JOIN addresses mapped_sender ON mapped_sender.ROWID = sender_address_lookup.address")
  }

  const receivedAtExpression = schema.messages.has("date_received")
    ? "messages.date_received"
    : schema.messages.has("display_date")
      ? "messages.display_date"
      : "NULL"

  const documentIdExpression = schema.messages.has("document_id") ? "messages.document_id" : "NULL"
  const messageIdExpression = schema.messages.has("message_id") ? "CAST(messages.message_id AS TEXT)" : "NULL"
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

  const resolvedSenderNameExpression = resolvedSenderNameParts.length > 0
    ? `COALESCE(${resolvedSenderNameParts.join(", ")})`
    : "NULL"

  const resolvedSenderAddressExpression = resolvedSenderAddressParts.length > 0
    ? `COALESCE(${resolvedSenderAddressParts.join(", ")})`
    : "NULL"

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
      mailboxes.url AS mailboxUrl
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

const buildSearchMessagesQuery = (schema: SchemaInfo, args: SearchEmailArguments): { sql: string; params: SQLQueryBindings[] } => {
  const canResolveSubject = schema.messages.has("subject") && schema.subjects.has("subject")
  const canResolveDirectSender = schema.messages.has("sender") && schema.addresses.has("address")
  const canJoinSenderLookup = schema.messages.has("sender") && schema.senders.size > 0
  const canResolveMappedSender =
    canJoinSenderLookup &&
    schema.senderAddresses.has("sender") &&
    schema.senderAddresses.has("address") &&
    schema.addresses.has("address")

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
    joins.push("LEFT JOIN (SELECT sender, MIN(address) AS address FROM sender_addresses GROUP BY sender) sender_address_lookup ON sender_address_lookup.sender = sender_lookup.ROWID")
    joins.push("LEFT JOIN addresses mapped_sender ON mapped_sender.ROWID = sender_address_lookup.address")
  }

  const receivedAtExpression = schema.messages.has("date_received")
    ? "messages.date_received"
    : schema.messages.has("display_date")
      ? "messages.display_date"
      : "NULL"

  const documentIdExpression = schema.messages.has("document_id") ? "messages.document_id" : "NULL"
  const messageIdExpression = schema.messages.has("message_id") ? "CAST(messages.message_id AS TEXT)" : "NULL"
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

  const resolvedSenderNameExpression = resolvedSenderNameParts.length > 0
    ? `COALESCE(${resolvedSenderNameParts.join(", ")})`
    : "NULL"

  const resolvedSenderAddressExpression = resolvedSenderAddressParts.length > 0
    ? `COALESCE(${resolvedSenderAddressParts.join(", ")})`
    : "NULL"

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
      messages.read AS readFlag
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

const isEmailLike = (value: string | undefined) => Boolean(value && value.includes("@"))

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

  const senderAddress = senderAddressCandidate
    ?? (isEmailLike(senderNameCandidate) ? senderNameCandidate : undefined)
    ?? (isEmailLike(senderReferenceCandidate) ? senderReferenceCandidate : undefined)
    ?? ""

  const senderName = senderNameCandidate && senderNameCandidate !== senderAddress ? senderNameCandidate : ""

  return {
    senderName,
    senderAddress,
  }
}

const isExcludedMailbox = (mailboxUrl: string, mailboxName: string, provider: "gmail" | "icloud" | string = "icloud") => {
  const normalized = mailboxName.toLowerCase()

  const excludedFragments = [
    "/junk", "/spam", "/trash", "deleted messages",
    "sent messages", "sent mail", "/drafts", "/outbox",
  ]

  // For non-Gmail accounts, also exclude "all mail" to avoid duplicates
  if (provider !== "gmail") {
    excludedFragments.push("all mail")
  }

  return excludedFragments.some((fragment) => normalized.includes(fragment)) || normalized.trim().endsWith("[gmail]")
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

  const displayMailboxName = (provider === "gmail" && mailboxName.toLowerCase().includes("all mail")) ? "INBOX" : mailboxName
  const messageId = cleanText(row.messageIdText) ?? ""
  const accountClassification = classifyAccountByMailboxUrl(mailboxUrl, config)
  const receivedAt = toIsoStringFromUnixSeconds(row.receivedAtUnix)
  const receivedAtDate = receivedAt ? new Date(receivedAt) : undefined
  const sender = normalizeSender(row)

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

const groupEmailsByAccount = (emails: NormalizedEmail[], config: EmailConfig) => {
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
  return [...groups.values()].sort((left, right) => {
    const leftIndex = order.indexOf(left.accountLabel)
    const rightIndex = order.indexOf(right.accountLabel)
    // Unknown labels sort to end
    return (leftIndex === -1 ? Infinity : leftIndex) - (rightIndex === -1 ? Infinity : rightIndex)
  })
}

export const formatEmailsForContent = (emails: NormalizedEmail[], argumentsValue: UnreadEmailArguments, config: EmailConfig) => {
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
      throw new Error(`Invalid arguments: unexpected field \"${key}\".`)
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
  const objectValue = validateArgumentsObject(value, ["subject", "sender", "after", "before", "mailbox", "provider", "unreadOnly", "limit"])
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

  if (after && isNaN(Date.parse(after))) {
    throw new Error(`Invalid 'after' date: '${after}'. Use ISO 8601 format.`)
  }
  if (before && isNaN(Date.parse(before))) {
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
        JSON.stringify({ handle: argumentsValue.handle, attachmentName: argumentsValue.attachmentName, savePath: tmpFilePath }),
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
  const allAccountKeys = new Set(rows.map((row) => getMailboxAccountKey(cleanText(row.mailboxUrl) ?? "")).filter(Boolean))
  const unconfiguredKeys = [...allAccountKeys].filter((key) => !config.accounts[key])
  const warnings: string[] = []
  if (unconfiguredKeys.length > 0) {
    warnings.push(`⚠️ ${unconfiguredKeys.length} unconfigured account(s): ${unconfiguredKeys.join(", ")}. Edit config/email.json to classify them.`)
  }

  return {
    content: [
      {
        type: "text",
        text: (warnings.length > 0 ? warnings.join("\n") + "\n\n" : "") + formatEmailsForContent(emails, argumentsValue, config),
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
    const message = error instanceof EmailToolError
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
    const message = error instanceof EmailToolError
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

// ── Shared Zod schemas ─────────────────────────────────────────────────

const handleSchema = z.object({
  accountId: z.string(),
  mailboxUrl: z.string(),
  mailId: z.string(),
})

const emailsArraySchema = z.array(
  z.object({
    id: z.string(),
    subject: z.string().optional(),
    handle: handleSchema,
  }),
).min(1)

// ── MCP Server ─────────────────────────────────────────────────────────

const server = new McpServer({ name: "apple-mail", version: "0.0.1" })

server.registerTool(
  "unread_emails",
  {
    description: "Read unread Apple Mail messages without fetching bodies.",
    inputSchema: {
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).optional()
        .describe("Maximum number of messages to return (1–100). Default: 25."),
      provider: z.enum(["gmail", "icloud"]).optional()
        .describe("Filter to a specific email provider."),
      mailbox: z.string().optional()
        .describe("Substring filter on mailbox name or URL (e.g. 'INBOX', 'work')."),
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
    description: "Mark Apple Mail messages as read. Each item in 'emails' must be a full email object with 'id', 'subject', and 'handle' fields — pass the objects exactly as returned by unread_emails, not bare handle objects.",
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
  "mark_emails_junk",
  {
    description: "Mark Apple Mail messages as junk/spam. Each item in 'emails' must be a full email object with 'id', 'subject', and 'handle' fields — pass the objects exactly as returned by unread_emails, not bare handle objects.",
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
    description: "Mark Apple Mail messages as not junk. Each item in 'emails' must be a full email object with 'id', 'subject', and 'handle' fields — pass the objects exactly as returned by unread_emails, not bare handle objects.",
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
      format: z.enum(["text", "base64"]).optional()
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
    description: "Search emails by subject, sender, and/or date range. Returns matching emails from all accounts. At least one search criterion (subject, sender, after, before) is required.",
    inputSchema: {
      subject: z.string().optional()
        .describe("Substring to match in the email subject line."),
      sender: z.string().optional()
        .describe("Substring to match in the sender email address or display name."),
      after: z.string().optional()
        .describe("ISO 8601 date string. Only return emails received on or after this date. Example: '2025-01-15' or '2025-01-15T09:00:00Z'."),
      before: z.string().optional()
        .describe("ISO 8601 date string. Only return emails received before this date. Example: '2025-03-01'."),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).optional()
        .describe("Maximum number of results to return (1–100). Default: 25."),
      provider: z.enum(["gmail", "icloud"]).optional()
        .describe("Filter to a specific email provider."),
      mailbox: z.string().optional()
        .describe("Substring filter on mailbox name or URL (e.g. 'INBOX', 'work')."),
      unreadOnly: z.boolean().optional()
        .describe("If true, only return unread emails. Defaults to false."),
    },
  },
  async (args) => {
    const argumentsValue = parseSearchEmailArguments(args)
    const result = await createSearchEmailResult(argumentsValue)
    return result as { content: { type: "text"; text: string }[]; isError?: boolean }
  },
)

// ── Entry point ────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
