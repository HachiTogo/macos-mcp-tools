import { describe, expect, test } from "bun:test"

import { DEFAULT_LIMIT, MAX_LIMIT } from "./constants"
import { emailsArraySchema, handleSchema, hasSearchCriteria, isoDateString, limitSchema } from "./schemas"

// These schemas replaced a hand-rolled argument layer. The rules that layer enforced have to still
// hold, and two of them are easy to write subtly wrong in zod, so they are pinned here.

describe("limitSchema", () => {
  test("an absent limit becomes the default, not undefined", () => {
    // `.default(x).optional()` would parse undefined -> undefined, which is how the old code ended
    // up relying on its hand-rolled parser to supply the real default.
    expect(limitSchema.parse(undefined)).toBe(DEFAULT_LIMIT)
  })

  test("accepts the documented range and rejects outside it", () => {
    expect(limitSchema.parse(1)).toBe(1)
    expect(limitSchema.parse(MAX_LIMIT)).toBe(MAX_LIMIT)
    expect(() => limitSchema.parse(0)).toThrow()
    expect(() => limitSchema.parse(MAX_LIMIT + 1)).toThrow()
    expect(() => limitSchema.parse(2.5)).toThrow()
    expect(() => limitSchema.parse("25")).toThrow()
  })
})

describe("isoDateString", () => {
  const after = isoDateString("after")

  test("accepts a bare date and a full timestamp", () => {
    expect(after.parse("2026-09-01")).toBe("2026-09-01")
    expect(after.parse("2026-09-01T09:00:00Z")).toBe("2026-09-01T09:00:00Z")
  })

  test("rejects something that is not a date, and names the field", () => {
    expect(() => after.parse("last tuesday")).toThrow(/after date/)
    expect(() => after.parse("")).toThrow()
  })
})

describe("handleSchema", () => {
  const handle = { accountId: "acct", mailboxUrl: "imap://acct/INBOX", mailId: "100" }

  test("requires all three identifying fields", () => {
    expect(handleSchema.parse(handle)).toEqual(handle)
    expect(() => handleSchema.parse({ accountId: "acct", mailboxUrl: "imap://acct/INBOX" })).toThrow()
    expect(() => handleSchema.parse("not an object")).toThrow()
  })
})

describe("emailsArraySchema", () => {
  const email = { id: "1", handle: { accountId: "a", mailboxUrl: "u", mailId: "m" } }

  test("requires at least one email, each carrying a handle", () => {
    expect(emailsArraySchema.parse([email])).toHaveLength(1)
    expect(() => emailsArraySchema.parse([])).toThrow()
    expect(() => emailsArraySchema.parse([{ id: "1" }])).toThrow()
  })

  test("subject is optional, because callers pass back what a read tool returned", () => {
    expect(emailsArraySchema.parse([{ ...email, subject: "Hello" }])[0]?.subject).toBe("Hello")
    expect(emailsArraySchema.parse([email])[0]?.subject).toBeUndefined()
  })
})

describe("hasSearchCriteria", () => {
  test("is true for any one criterion and false for none", () => {
    expect(hasSearchCriteria({ subject: "invoice" })).toBe(true)
    expect(hasSearchCriteria({ sender: "billing@example.com" })).toBe(true)
    expect(hasSearchCriteria({ after: "2026-09-01" })).toBe(true)
    expect(hasSearchCriteria({ before: "2026-09-01" })).toBe(true)
    expect(hasSearchCriteria({})).toBe(false)
  })

  test("an empty string is not a criterion", () => {
    expect(hasSearchCriteria({ subject: "" })).toBe(false)
  })
})
