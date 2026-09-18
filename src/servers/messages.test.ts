import { describe, expect, test } from "bun:test"

import { escapeLikePattern, extractTextFromBody, resolveText } from "./messages"

// Build a minimal attributedBody-style blob: opaque header, "NSString", "+", length prefix, UTF-8 text.
const buildBody = (text: string, lengthForm: "short" | "u16" = "short"): Uint8Array => {
  const encoded = new TextEncoder().encode(text)
  const header = new Uint8Array([0x04, 0x0b, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d, 0x74, 0x79, 0x70, 0x65, 0x64, 0x00])
  const marker = new TextEncoder().encode("NSString")
  const plus = new Uint8Array([0x01, 0x94, 0x84, 0x01, 0x2b])
  const length =
    lengthForm === "short"
      ? new Uint8Array([encoded.length])
      : new Uint8Array([0x81, encoded.length & 0xff, encoded.length >> 8])
  return new Uint8Array([...header, ...marker, ...plus, ...length, ...encoded, 0x86])
}

describe("attributedBody decoding", () => {
  test("extracts short-form text", () => {
    expect(extractTextFromBody(buildBody("See you at the dentist"))).toBe("See you at the dentist")
  })

  test("extracts 16-bit length form text", () => {
    const long = "x".repeat(300)
    expect(extractTextFromBody(buildBody(long, "u16"))).toBe(long)
  })

  test("returns null for empty or unrecognised blobs", () => {
    expect(extractTextFromBody(null)).toBeNull()
    expect(extractTextFromBody(new Uint8Array())).toBeNull()
    expect(extractTextFromBody(new TextEncoder().encode("no marker here"))).toBeNull()
  })
})

describe("resolveText", () => {
  test("prefers the text column and falls back to attributedBody", () => {
    expect(resolveText({ text: "plain", attributedBody: buildBody("rich") })).toBe("plain")
    expect(resolveText({ text: null, attributedBody: buildBody("rich") })).toBe("rich")
    expect(resolveText({ text: null, attributedBody: null })).toBeNull()
  })
})

describe("escapeLikePattern", () => {
  test("escapes LIKE metacharacters and the escape character itself", () => {
    expect(escapeLikePattern("50%")).toBe("50\\%")
    expect(escapeLikePattern("a_b")).toBe("a\\_b")
    expect(escapeLikePattern("back\\slash")).toBe("back\\\\slash")
    expect(escapeLikePattern("plain")).toBe("plain")
  })
})
