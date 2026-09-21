import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

import { PACKAGE_VERSION } from "../lib/version"
import { discoverAndWriteConfig, loadEmailConfig } from "./mail/config"
import { EmailToolError } from "./mail/errors"
import {
  formatEmailsForContent,
  formatFlagEmailsSummary,
  formatForwardEmailSummary,
  formatMarkEmailsJunkSummary,
  formatMarkEmailsNotJunkSummary,
  formatMarkEmailsReadSummary,
  formatReplyEmailSummary,
  formatSearchEmailSummary,
  formatSendEmailSummary,
} from "./mail/format"
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
import { getMailboxAccountKey, getProviderByAccount } from "./mail/mailbox"
import { cleanText, matchesMailboxFilter, normalizeEmail, SOURCE_NAME } from "./mail/normalize"
import {
  buildSearchMessagesQuery,
  buildUnreadMessagesQuery,
  ensureRequiredColumns,
  getSchemaInfo,
} from "./mail/queries"
import type {
  EmailAttachment,
  EmailHandle,
  EmailLink,
  EmailRow,
  ExtractEmailLinksArguments,
  ExtractEmailLinksResult,
  FetchEmailAttachmentArguments,
  FetchEmailAttachmentResult,
  FetchEmailBodyArguments,
  FetchEmailBodyResult,
  FlagEmailsArguments,
  FlagEmailsResult,
  FlagEmailsTarget,
  ForwardEmailArguments,
  ForwardEmailResult,
  ListEmailAttachmentsArguments,
  ListEmailAttachmentsResult,
  MarkEmailsJunkArguments,
  MarkEmailsJunkResult,
  MarkEmailsJunkTarget,
  MarkEmailsNotJunkArguments,
  MarkEmailsNotJunkResult,
  MarkEmailsNotJunkTarget,
  MarkEmailsReadArguments,
  MarkEmailsReadResult,
  MarkEmailsReadTarget,
  NormalizedEmail,
  ReplyEmailArguments,
  ReplyEmailResult,
  SearchEmailArguments,
  SendEmailArguments,
  SendEmailResult,
  UnreadEmailArguments,
} from "./mail/types"

const MAIL_DB_PATH = join(homedir(), "Library/Mail/V10/MailData/Envelope Index")
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
const BODY_MAX_CHARS = 8_000
const MAX_LINKS = 500
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "local"

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
