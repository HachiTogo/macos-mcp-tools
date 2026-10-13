import { describe, expect, test } from "bun:test"

import { extractLinksFromSource } from "./message-content"
import { decodeTextPart, parseContentType, quotedPrintableBytes, textParts } from "./mime"

const crlf = (...lines: string[]) => lines.join("\r\n")

// Shaped like a GitHub Actions notification, the message that exposed the bug: each part lists
// Content-Transfer-Encoding before Content-Type, the plain part has rules of dashes, and the HTML
// is quoted-printable with soft line breaks inside its hrefs. All of it synthetic.
const notification = crlf(
  "From: Example CI <notifications@example.com>",
  "Subject: Run failed",
  'Content-Type: multipart/alternative; boundary="b1"',
  "Mime-Version: 1.0",
  "",
  "--b1",
  "Content-Transfer-Encoding: quoted-printable",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Run failed",
  "----------------------------------------",
  "View it: https://ci.example.com/runs/123",
  "--b1",
  "Content-Transfer-Encoding: quoted-printable",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p><a href=3D"https://ci.example.com/runs/123/attem=',
  'pts/1?pr=3D7">View run</a></p>',
  "<!-- layout",
  "-->",
  '<a href=3D"https://ci.example.com/settings">Settings</a>',
  "--b1--",
  "",
)

describe("textParts", () => {
  test("reads a part's headers in any order and ends it only at the boundary", () => {
    const parts = textParts(notification)
    expect(parts.map((part) => [part.type, part.encoding])).toEqual([
      ["text/plain", "quoted-printable"],
      ["text/html", "quoted-printable"],
    ])
    expect(parts[0]?.body).toContain("View it: https://ci.example.com/runs/123")
    expect(parts[1]?.body).toContain("Settings</a>")
    expect(parts[1]?.body.endsWith("\r\n")).toBe(false)
  })

  test("follows nested multiparts and skips attachments and forwarded messages", () => {
    const source = crlf(
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "preamble, not a part",
      "--outer",
      "Content-Type: multipart/alternative; boundary=inner",
      "",
      "--inner",
      "Content-Type: text/html",
      "",
      '<a href="https://example.com/body">body</a>',
      "--inner--",
      "--outer",
      "Content-Type: text/html",
      "Content-Disposition: attachment; filename=page.html",
      "",
      '<a href="https://example.com/attached">attached</a>',
      "--outer",
      "Content-Type: message/rfc822",
      "",
      "Content-Type: text/html",
      "",
      '<a href="https://example.com/forwarded">forwarded</a>',
      "--outer--",
      "epilogue",
    )
    expect(textParts(source).map((part) => part.body)).toEqual(['<a href="https://example.com/body">body</a>'])
  })

  test("a part with no headers is plain text, and a source with no Content-Type is one plain part", () => {
    const source = crlf('Content-Type: multipart/mixed; boundary="b"', "", "--b", "", "just text", "--b--")
    expect(textParts(source)).toEqual([{ type: "text/plain", charset: "utf-8", encoding: "", body: "just text" }])
    expect(textParts(crlf("Subject: hi", "", "body"))[0]?.type).toBe("text/plain")
  })

  test("stops at a depth limit instead of recursing forever", () => {
    let source = crlf("Content-Type: text/html", "", "<p>deep</p>")
    for (let i = 0; i < 12; i++)
      source = crlf(`Content-Type: multipart/mixed; boundary="d${i}"`, "", `--d${i}`, source, `--d${i}--`)
    expect(textParts(source)).toEqual([])
  })
})

describe("decoding", () => {
  test("content-type parameters, quoted or not", () => {
    expect(parseContentType('Text/HTML; Charset="ISO-8859-1"; boundary=abc')).toEqual({
      type: "text/html",
      params: { charset: "ISO-8859-1", boundary: "abc" },
    })
  })

  test("quoted-printable keeps a multi-byte character whole and drops soft breaks with trailing space", () => {
    const part = {
      type: "text/plain" as const,
      charset: "utf-8",
      encoding: "quoted-printable",
      body: "It=E2=80=99s =  \r\nhere",
    }
    expect(decodeTextPart(part, [])).toBe("It’s here")
    expect([...quotedPrintableBytes("a=3Db")]).toEqual([97, 61, 98])
  })

  test("base64 in a declared charset", () => {
    const body = Buffer.from("café", "latin1").toString("base64")
    expect(decodeTextPart({ type: "text/plain", charset: "iso-8859-1", encoding: "base64", body }, [])).toBe("café")
  })

  test("an unsupported charset is read as UTF-8 and reported", () => {
    const warnings: string[] = []
    const text = decodeTextPart(
      { type: "text/plain", charset: "x-unknown", encoding: "quoted-printable", body: "ok" },
      warnings,
    )
    expect(text).toBe("ok")
    expect(warnings).toEqual([
      '⚠️ Charset "x-unknown" is not supported; read as UTF-8, so some characters may be wrong.',
    ])
  })
})

describe("extractLinksFromSource on multipart mail", () => {
  test("decodes quoted-printable hrefs whose encoding header comes first", () => {
    expect(extractLinksFromSource(notification).links).toEqual([
      { url: "https://ci.example.com/runs/123/attempts/1?pr=7", text: "View run" },
      { url: "https://ci.example.com/settings", text: "Settings" },
    ])
  })

  test("unescapes an href's HTML entities", () => {
    const source = crlf("Content-Type: text/html", "", '<a href="https://example.com/x?a=1&amp;b=2">x</a>')
    expect(extractLinksFromSource(source).links[0]?.url).toBe("https://example.com/x?a=1&b=2")
  })

  test("reads links from every HTML part, the way Mail splits a message around an inline image", () => {
    const source = crlf(
      'Content-Type: multipart/mixed; boundary="m"',
      "",
      "--m",
      "Content-Type: text/html",
      "",
      '<a href="https://example.com/first">first</a>',
      "--m",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      "",
      "iVBORw0KGgo=",
      "--m",
      "Content-Type: text/html",
      "",
      '<a href="https://example.com/second">second</a>',
      "--m--",
    )
    expect(extractLinksFromSource(source).links.map((link) => link.text)).toEqual(["first", "second"])
  })

  test("a message with no text part has no links, not the URLs in its headers", () => {
    const source = crlf(
      "List-Unsubscribe: <https://example.com/unsubscribe>",
      'Content-Type: multipart/mixed; boundary="m"',
      "",
      "--m",
      "Content-Type: application/pdf",
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjQK",
      "--m--",
    )
    expect(extractLinksFromSource(source).links).toEqual([])
  })
})
