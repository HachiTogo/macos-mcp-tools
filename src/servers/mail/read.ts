// Everything the mail tools do that only reads: message bodies and raw source, MIME decoding,
// link and attachment extraction, and the two Envelope Index queries. Bodies and attachments come
// from Mail.app through JXA because the Envelope Index does not store them.

import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import { discoverAndWriteConfig, loadEmailConfig, resolveConfigPath } from "./config"
import { BODY_MAX_CHARS, MAIL_DB_PATH, MAX_LINKS, TIME_ZONE } from "./constants"
import { EmailToolError } from "./errors"
import { formatEmailsForContent, formatSearchEmailSummary } from "./format"
import {
  FETCH_EMAIL_ATTACHMENT_JXA,
  FETCH_EMAIL_BODY_JXA,
  FETCH_EMAIL_SOURCE_JXA,
  LIST_EMAIL_ATTACHMENTS_JXA,
} from "./jxa-scripts"
import { getMailboxAccountKey, getProviderByAccount } from "./mailbox"
import { cleanText, matchesMailboxFilter, normalizeEmail, SOURCE_NAME } from "./normalize"
import {
  buildSearchMessagesQuery,
  buildUnreadMessagesQuery,
  ensureRequiredColumns,
  getSchemaInfo,
  type QueryWindow,
} from "./queries"
import type {
  EmailAttachment,
  EmailConfig,
  EmailHandle,
  EmailLink,
  EmailRow,
  ExtractEmailLinksArguments,
  ExtractEmailLinksResult,
  FetchEmailAttachmentArguments,
  FetchEmailAttachmentResult,
  FetchEmailBodyArguments,
  FetchEmailBodyResult,
  ListEmailAttachmentsArguments,
  ListEmailAttachmentsResult,
  SearchEmailArguments,
  UnreadEmailArguments,
} from "./types"

export const fetchEmailBodyWithJxa = (handle: EmailHandle): { found: boolean; body: string } => {
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

export const createFetchEmailBodyResult = async (argumentsValue: FetchEmailBodyArguments): Promise<CallToolResult> => {
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

export const fetchEmailSourceWithJxa = (handle: EmailHandle): { found: boolean; source: string } => {
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

export const decodeQuotedPrintable = (value: string): string => {
  const softBreaksRemoved = value.replace(/=\r?\n/g, "")
  return softBreaksRemoved.replace(/=([0-9A-Fa-f]{2})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
}

export const decodeBase64Body = (value: string): string => {
  const stripped = value.replace(/\s+/g, "")
  try {
    return Buffer.from(stripped, "base64").toString("utf8")
  } catch {
    return ""
  }
}

export const decodeHtmlEntities = (value: string): string => {
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

export const findMimePart = (source: string, contentTypePattern: RegExp): { body: string; encoding: string } | null => {
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

export const decodePartBody = (body: string, encoding: string): string => {
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

export const createExtractEmailLinksResult = async (
  argumentsValue: ExtractEmailLinksArguments,
): Promise<CallToolResult> => {
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

    const content = ((): CallToolResult["content"] => {
      if (!found) {
        return [{ type: "text", text: "(message not found)" }]
      }
      if (links.length === 0) {
        return [{ type: "text", text: "No links found." }]
      }
      const header = `Found ${links.length} link${links.length === 1 ? "" : "s"}${truncated ? " (truncated)" : ""}`
      const lines = links.map((link) => `- [${link.text}](${link.url})`)
      return [{ type: "text", text: header }, ...lines.map((line) => ({ type: "text" as const, text: line }))]
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

export const listEmailAttachmentsWithJxa = (
  handle: EmailHandle,
): { found: boolean; attachments: EmailAttachment[] } => {
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

export const createListEmailAttachmentsResult = async (
  argumentsValue: ListEmailAttachmentsArguments,
): Promise<CallToolResult> => {
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

export const createFetchEmailAttachmentResult = async (
  argumentsValue: FetchEmailAttachmentArguments,
): Promise<CallToolResult> => {
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

/**
 * The account config for a read. A file that exists but does not parse is reported, never
 * replaced: discovery writes defaults, and overwriting a hand-edited file with them loses work
 * the user cannot get back.
 */
const resolveConfigForRead = (database: Database): { config: EmailConfig; warnings: string[] } => {
  const path = resolveConfigPath()
  const loaded = loadEmailConfig()

  if (loaded.status === "invalid") {
    throw new EmailToolError(
      `Email account config at ${path} could not be read: ${loaded.reason}. Fix or delete that file; it will not be overwritten.`,
    )
  }

  if (loaded.status === "ok" && Object.keys(loaded.config.accounts).length > 0) {
    return { config: loaded.config, warnings: [] }
  }

  const discovered = discoverAndWriteConfig(database, path)
  return {
    config: discovered.config,
    warnings: discovered.writeError
      ? [
          `⚠️ Could not save the account config to ${path}: ${discovered.writeError}. Accounts are rediscovered on every call until this is fixed.`,
        ]
      : [],
  }
}

/** Rows a single statement returns while looking for matches. */
const SCAN_PAGE = 250
/** Ceiling on rows examined for one call, so a narrow filter over a huge mailbox still terminates. */
const MAX_SCAN = 5_000

type Scan<T> = { matches: T[]; scanned: number; exhausted: boolean }

/**
 * Pages through a query until enough rows survive filtering.
 *
 * Provider, mailbox and exclusion filters depend on the account config and on decoded mailbox
 * names, so none of them can be pushed into the SQL. Reading one fixed page and filtering it --
 * what this used to do -- means a filter matching nothing among the newest 250 messages reports no
 * results at all, however many actually match.
 */
const scanForMatches = <Row, Match>(
  fetchPage: (page: QueryWindow) => Row[],
  keep: (row: Row) => Match | undefined,
  need: number,
): Scan<Match> => {
  const matches: Match[] = []
  let scanned = 0
  let exhausted = false

  while (matches.length < need && scanned < MAX_SCAN) {
    const rows = fetchPage({ limit: SCAN_PAGE, offset: scanned })
    scanned += rows.length

    for (const row of rows) {
      const match = keep(row)
      if (match) matches.push(match)
    }

    if (rows.length < SCAN_PAGE) {
      exhausted = true
      break
    }
  }

  return { matches, scanned, exhausted }
}

export const runUnreadEmailRead = (database: Database, argumentsValue: UnreadEmailArguments): CallToolResult => {
  const schema = getSchemaInfo(database)
  ensureRequiredColumns(schema)

  const { config, warnings: configWarnings } = resolveConfigForRead(database)

  const providerByAccount = getProviderByAccount(config)
  const allAccountKeys = new Set<string>()
  const needed = argumentsValue.offset + argumentsValue.limit

  const scan = scanForMatches(
    (page) => database.query(buildUnreadMessagesQuery(schema, page)).all() as EmailRow[],
    (row) => {
      const accountKey = getMailboxAccountKey(cleanText(row.mailboxUrl) ?? "")
      if (accountKey) allAccountKeys.add(accountKey)

      const email = normalizeEmail(row, providerByAccount, config)
      if (!email) return undefined
      if (argumentsValue.provider && email.provider !== argumentsValue.provider) return undefined
      if (!matchesMailboxFilter(email, argumentsValue.mailbox)) return undefined
      return email
    },
    needed,
  )

  const emails = scan.matches.slice(argumentsValue.offset, needed)
  const unconfiguredKeys = [...allAccountKeys].filter((key) => !config.accounts[key])
  const warnings: string[] = [...configWarnings]
  if (!scan.exhausted && scan.matches.length < needed) {
    warnings.push(
      `⚠️ Stopped after examining ${scan.scanned} messages without filling the page. More may match; narrow the filter, or page with offset.`,
    )
  }
  if (unconfiguredKeys.length > 0) {
    warnings.push(
      `⚠️ ${unconfiguredKeys.length} unconfigured account(s): ${unconfiguredKeys.join(", ")}. Edit ${resolveConfigPath()} to classify them.`,
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

export const createUnreadEmailsResult = async (argumentsValue: UnreadEmailArguments): Promise<CallToolResult> => {
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

export const createSearchEmailResult = async (args: SearchEmailArguments): Promise<CallToolResult> => {
  let database: Database | undefined

  try {
    const db = new Database(MAIL_DB_PATH, { readonly: true })
    database = db
    const schema = getSchemaInfo(db)
    ensureRequiredColumns(schema)

    const { config } = resolveConfigForRead(db)

    const providerByAccount = getProviderByAccount(config)
    const needed = args.offset + args.limit
    const scan = scanForMatches(
      (page) => {
        const { sql, params } = buildSearchMessagesQuery(schema, args, page)
        return db.query(sql).all(...params) as (EmailRow & { readFlag?: number | null })[]
      },
      (row) => {
        const normalized = normalizeEmail(row, providerByAccount, config)
        if (!normalized) return undefined
        // The query returns read and unread alike, so the flag decides rather than the caller.
        normalized.isUnread = row.readFlag === 0
        if (args.provider && normalized.provider !== args.provider) return undefined
        if (!matchesMailboxFilter(normalized, args.mailbox)) return undefined
        return normalized
      },
      needed,
    )

    const emails = scan.matches.slice(args.offset, needed)

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
