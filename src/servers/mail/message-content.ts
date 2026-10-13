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
import { decodeTextPart, textParts } from "./mime"
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

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" }

const occurrences = (text: string, char: string) => text.split(char).length - 1

/**
 * A URL found in plain text, without the punctuation of the sentence around it: "see
 * https://example.com/a." links to /a. A closing bracket stays when the URL opened it, as in
 * https://en.wikipedia.org/wiki/Mercury_(planet).
 */
export const trimUrlEnd = (url: string): string => {
  let trimmed = url
  for (;;) {
    const last = trimmed.at(-1) ?? ""
    const opener = CLOSERS[last]
    if (".,;:!?".includes(last) && last !== "") trimmed = trimmed.slice(0, -1)
    else if (opener && occurrences(trimmed, last) > occurrences(trimmed, opener)) trimmed = trimmed.slice(0, -1)
    else return trimmed
  }
}

/**
 * Links from every inline HTML part, or from the plain-text parts when there is no HTML. A message
 * with no text part has no links: the raw source is headers and encoded attachments.
 */
export const extractLinksFromSource = (
  source: string,
): { links: EmailLink[]; truncated: boolean; warnings: string[] } => {
  const parts = textParts(source)
  const html = parts.filter((part) => part.type === "text/html")
  const warnings: string[] = []
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

  for (const part of html) {
    const decodedHtml = decodeTextPart(part, warnings)
    const anchorRegex = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi
    for (const match of decodedHtml.matchAll(anchorRegex)) {
      // Attribute values are HTML-escaped: a query string arrives as `?a=1&amp;b=2`.
      const href = decodeHtmlEntities((match[1] ?? match[2] ?? match[3] ?? "").trim())
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
  }

  if (html.length === 0) {
    for (const part of parts) {
      const urlRegex = /\bhttps?:\/\/[^\s<>"']+/g
      for (const match of decodeTextPart(part, warnings).matchAll(urlRegex)) {
        const url = trimUrlEnd(match[0])
        if (!/^https?:\/\/$/.test(url)) pushLink(url, url)
      }
    }
  }

  if (links.length > MAX_LINKS) {
    return { links: links.slice(0, MAX_LINKS), truncated: true, warnings }
  }
  return { links, truncated: false, warnings }
}

export const createExtractEmailLinksResult = async (
  argumentsValue: ExtractEmailLinksArguments,
): Promise<CallToolResult> => {
  try {
    const { found, source } = fetchEmailSourceWithJxa(argumentsValue.handle)
    const { links, truncated, warnings } = found
      ? extractLinksFromSource(source)
      : { links: [] as EmailLink[], truncated: false, warnings: [] as string[] }

    const result: ExtractEmailLinksResult = {
      handle: argumentsValue.handle,
      found,
      links,
      count: links.length,
      truncated,
      ...(warnings.length > 0 ? { warnings } : {}),
    }

    const content = ((): CallToolResult["content"] => {
      if (!found) {
        return [{ type: "text", text: "(message not found)" }]
      }
      if (links.length === 0) {
        return [{ type: "text", text: [...warnings, "No links found."].join("\n") }]
      }
      const header = [
        ...warnings,
        `Found ${links.length} link${links.length === 1 ? "" : "s"}${truncated ? " (truncated)" : ""}`,
      ].join("\n")
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
