import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

import { PACKAGE_VERSION } from "../lib/version"
import { DEFAULT_LIMIT, MAX_LIMIT } from "./mail/constants"
import {
  createFlagEmailsResult,
  createForwardEmailResult,
  createMarkEmailsJunkResult,
  createMarkEmailsNotJunkResult,
  createMarkEmailsReadResult,
  createReplyEmailResult,
  createSendEmailResult,
} from "./mail/mutate"
import {
  createExtractEmailLinksResult,
  createFetchEmailAttachmentResult,
  createFetchEmailBodyResult,
  createListEmailAttachmentsResult,
  createSearchEmailResult,
  createUnreadEmailsResult,
} from "./mail/read"
import type {
  EmailHandle,
  ExtractEmailLinksArguments,
  FetchEmailAttachmentArguments,
  FetchEmailBodyArguments,
  FlagEmailsArguments,
  FlagEmailsTarget,
  ForwardEmailArguments,
  ListEmailAttachmentsArguments,
  MarkEmailsJunkArguments,
  MarkEmailsNotJunkArguments,
  MarkEmailsReadArguments,
  ReplyEmailArguments,
  SearchEmailArguments,
  SendEmailArguments,
  UnreadEmailArguments,
} from "./mail/types"

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
