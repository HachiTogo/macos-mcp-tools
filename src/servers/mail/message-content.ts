// What the mail tools read from one message: its body and raw source, MIME decoding, links and
// attachments. These come from Mail.app through JXA because the Envelope Index does not store them.

import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import { runJxa } from "../../lib/jxa"
import { errorMessage } from "../../lib/mcp-result"

import { BODY_MAX_CHARS, MAX_LINKS } from "./constants"
import {
  FETCH_EMAIL_ATTACHMENT_JXA,
  FETCH_EMAIL_BODY_JXA,
  FETCH_EMAIL_SOURCE_JXA,
  LIST_EMAIL_ATTACHMENTS_JXA,
} from "./jxa-scripts"
import type {
  EmailAttachment,
  EmailHandle,
  EmailLink,
  ExtractEmailLinksArguments,
  ExtractEmailLinksResult,
  FetchEmailAttachmentArguments,
  FetchEmailAttachmentResult,
  FetchEmailBodyArguments,
  FetchEmailBodyResult,
  ListEmailAttachmentsArguments,
  ListEmailAttachmentsResult,
} from "./types"

export const fetchEmailBodyWithJxa = (handle: EmailHandle): { found: boolean; body: string } => {
  const stdout = runJxa(FETCH_EMAIL_BODY_JXA, { handle })

  const output = JSON.parse(stdout || "{}") as { found?: boolean; body?: string }
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
    const detail = errorMessage(error)
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
  const stdout = runJxa(FETCH_EMAIL_SOURCE_JXA, { handle })

  const output = JSON.parse(stdout || "{}") as { found?: boolean; source?: string }
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
    const detail = errorMessage(error)
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
  const stdout = runJxa(LIST_EMAIL_ATTACHMENTS_JXA, { handle })

  const output = JSON.parse(stdout || "{}") as { found?: boolean; attachments?: EmailAttachment[] }
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
    const detail = errorMessage(error)
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
    const stdout = runJxa(FETCH_EMAIL_ATTACHMENT_JXA, {
      handle: argumentsValue.handle,
      attachmentName: argumentsValue.attachmentName,
      savePath: tmpFilePath,
    })

    const jxaOutput = JSON.parse(stdout || "{}") as { saved?: boolean; error?: string }

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
    const detail = errorMessage(error)
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
