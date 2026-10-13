// Enough of MIME to read a message's text parts from the raw source Mail returns.
//
// A part's headers come in any order -- GitHub puts Content-Transfer-Encoding before Content-Type
// -- so they are read as a block, and a part ends only at its parent's declared boundary, never at
// the first line that merely starts with "--" (a plain-text rule of dashes, an HTML "-->").

export type TextPart = {
  type: "text/html" | "text/plain"
  charset: string
  /** Content-Transfer-Encoding, lowercased; "" when absent. */
  encoding: string
  body: string
}

/** How deep nested multiparts are followed, so a malformed or hostile message still terminates. */
const MAX_DEPTH = 10

/** An entity's headers, unfolded and keyed by lowercase name, and its body. */
const splitEntity = (raw: string): { headers: Map<string, string>; body: string } => {
  // A part may have no headers at all, in which case it opens with the blank line.
  const blank = /^\r?\n/.test(raw) ? /^\r?\n/.exec(raw) : /\r?\n\r?\n/.exec(raw)
  const head = blank ? raw.slice(0, blank.index) : raw
  const body = blank ? raw.slice(blank.index + blank[0].length) : ""

  const headers = new Map<string, string>()
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim())
  }
  return { headers, body }
}

/** `text/html; charset="utf-8"` as its lowercase type and its parameters. */
export const parseContentType = (value: string): { type: string; params: Record<string, string> } => {
  const [type = "", ...rest] = value.split(";")
  const params: Record<string, string> = {}
  for (const match of rest.join(";").matchAll(/([^=;\s]+)\s*=\s*(?:"([^"]*)"|([^;\s]*))/g)) {
    params[match[1].toLowerCase()] = match[2] ?? match[3] ?? ""
  }
  return { type: type.trim().toLowerCase(), params }
}

/**
 * A multipart body's parts. Only a line that is exactly `--boundary` (or `--boundary--`, which
 * closes it) delimits; the preamble before the first and the epilogue after the last are dropped.
 * The line break before a delimiter belongs to the delimiter, not the part.
 */
const splitMultipart = (body: string, boundary: string): string[] => {
  const open = `--${boundary}`
  const close = `--${boundary}--`
  const parts: string[] = []
  let current: string[] | undefined

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trimEnd()
    if (trimmed === open || trimmed === close) {
      if (current) parts.push(current.join("\n"))
      current = trimmed === close ? undefined : []
      if (trimmed === close) break
      continue
    }
    current?.push(line)
  }
  if (current) parts.push(current.join("\n"))
  return parts
}

/**
 * Every inline text/html and text/plain part, in order. Multiparts are followed to any depth up to
 * MAX_DEPTH; attachments and forwarded messages (message/rfc822) are not text of this message. A
 * source that is not multipart is its own single part, text/plain unless it says otherwise.
 */
export const textParts = (source: string, depth = 0): TextPart[] => {
  const { headers, body } = splitEntity(source)
  const { type, params } = parseContentType(headers.get("content-type") ?? "text/plain")

  if (type.startsWith("multipart/")) {
    if (!params.boundary || depth >= MAX_DEPTH) return []
    return splitMultipart(body, params.boundary).flatMap((part) => textParts(part, depth + 1))
  }

  const disposition = (headers.get("content-disposition") ?? "").split(";")[0].trim().toLowerCase()
  if (disposition === "attachment") return []
  if (type !== "text/html" && type !== "text/plain") return []

  return [
    {
      type,
      charset: params.charset || "utf-8",
      encoding: (headers.get("content-transfer-encoding") ?? "").trim().toLowerCase(),
      body,
    },
  ]
}

/** Quoted-printable as the bytes it encodes; soft line breaks may carry trailing whitespace. */
export const quotedPrintableBytes = (value: string): Uint8Array => {
  const bytes: number[] = []
  const encoder = new TextEncoder()
  for (const piece of value.replace(/=[ \t]*\r?\n/g, "").split(/(=[0-9A-Fa-f]{2})/)) {
    if (/^=[0-9A-Fa-f]{2}$/.test(piece)) bytes.push(Number.parseInt(piece.slice(1), 16))
    else for (const byte of encoder.encode(piece)) bytes.push(byte)
  }
  return Uint8Array.from(bytes)
}

/**
 * A part's text. Quoted-printable and base64 are decoded to bytes and then read in the part's
 * charset, so a UTF-8 character split across `=E2=80=99` comes back whole. A 7bit or 8bit part is
 * already text. A charset this runtime cannot decode is read as UTF-8 and reported in `warnings`.
 */
export const decodeTextPart = (part: TextPart, warnings: string[]): string => {
  let bytes: Uint8Array
  if (part.encoding === "quoted-printable") bytes = quotedPrintableBytes(part.body)
  else if (part.encoding === "base64") bytes = Uint8Array.from(Buffer.from(part.body.replace(/\s+/g, ""), "base64"))
  else return part.body

  try {
    return new TextDecoder(part.charset).decode(bytes)
  } catch {
    warnings.push(`⚠️ Charset "${part.charset}" is not supported; read as UTF-8, so some characters may be wrong.`)
    return new TextDecoder("utf-8").decode(bytes)
  }
}
