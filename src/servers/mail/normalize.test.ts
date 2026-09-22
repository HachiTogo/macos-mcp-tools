import { describe, expect, test } from "bun:test"

import {
  matchesMailboxFilter,
  normalizeEmail,
  normalizeSender,
  normalizeSubject,
  toSearchBoundSeconds,
} from "./normalize"
import type { EmailConfig, EmailRow, NormalizedEmail } from "./types"

// normalizeEmail is where a row stops being Envelope Index columns and becomes what an agent sees,
// and it had no coverage. The Envelope Index stores subjects and senders across several columns
// that are populated inconsistently, so most of what these functions do is choose between
// candidates -- which is exactly the part that breaks silently.

// The account key is derived from the mailbox URL's authority, not stored separately, so the
// config and the provider map have to be keyed by exactly this string.
const ACCOUNT = "work%40example.com@imap.example.com"
const INBOX = `imap://${ACCOUNT}/INBOX`

const CONFIG: EmailConfig = {
  accounts: { [ACCOUNT]: { label: "Work", category: "work", provider: "gmail" } },
  displayOrder: ["Work"],
}

const row = (overrides: Partial<EmailRow> = {}): EmailRow => ({
  rowIdText: "100",
  messageIdText: "40",
  documentId: "doc-100",
  receivedAtUnix: Math.floor(Date.UTC(2026, 8, 20, 17, 30) / 1000),
  resolvedSubject: "Quarterly invoice",
  subjectReferenceText: null,
  subjectPrefix: null,
  resolvedSenderName: "Vendor Billing",
  resolvedSenderAddress: "billing@vendor.example",
  senderReferenceText: null,
  mailboxUrl: INBOX,
  messageIdHeader: "<abc@vendor.example>",
  ...overrides,
})

describe("normalizeSubject", () => {
  test("prefers the resolved subject, then the prefix, then a non-numeric reference", () => {
    expect(normalizeSubject(row())).toBe("Quarterly invoice")
    expect(normalizeSubject(row({ resolvedSubject: null, subjectPrefix: "Re: " }))).toBe("Re:")
    expect(
      normalizeSubject(row({ resolvedSubject: null, subjectPrefix: null, subjectReferenceText: "Real subject" })),
    ).toBe("Real subject")
  })

  test("does not show a bare row id as the subject", () => {
    const numeric = row({ resolvedSubject: null, subjectPrefix: null, subjectReferenceText: "48213" })
    expect(normalizeSubject(numeric)).toBe("(no subject)")
    expect(normalizeSubject(row({ resolvedSubject: "   ", subjectPrefix: null, subjectReferenceText: null }))).toBe(
      "(no subject)",
    )
  })
})

describe("normalizeSender", () => {
  test("keeps the name and address apart when both are present", () => {
    expect(normalizeSender(row())).toEqual({ senderName: "Vendor Billing", senderAddress: "billing@vendor.example" })
  })

  test("promotes an address-shaped name when no address column resolved", () => {
    expect(normalizeSender(row({ resolvedSenderName: "who@example.com", resolvedSenderAddress: null }))).toEqual({
      senderName: "",
      senderAddress: "who@example.com",
    })
  })

  test("falls back to the reference column only when it looks like an address", () => {
    const fromReference = row({
      resolvedSenderName: null,
      resolvedSenderAddress: null,
      senderReferenceText: "fallback@example.com",
    })
    expect(normalizeSender(fromReference).senderAddress).toBe("fallback@example.com")

    const numericReference = row({
      resolvedSenderName: null,
      resolvedSenderAddress: null,
      senderReferenceText: "20",
    })
    expect(normalizeSender(numericReference)).toEqual({ senderName: "", senderAddress: "" })
  })
})

describe("normalizeEmail", () => {
  const providers = new Map<string, "gmail" | "icloud">([[ACCOUNT, "gmail"]])

  test("carries the account classification from config", () => {
    const email = normalizeEmail(row(), providers, CONFIG)
    expect(email?.accountLabel).toBe("Work")
    expect(email?.accountCategory).toBe("work")
    expect(email?.provider).toBe("gmail")
  })

  test("drops rows with no mailbox URL and rows in excluded mailboxes", () => {
    expect(normalizeEmail(row({ mailboxUrl: null }), providers, CONFIG)).toBeUndefined()
    const junk = row({ mailboxUrl: `imap://${ACCOUNT}/[Gmail]/Spam` })
    expect(normalizeEmail(junk, providers, CONFIG)).toBeUndefined()
  })

  test("presents Gmail's All Mail as INBOX", () => {
    const allMail = row({ mailboxUrl: `imap://${ACCOUNT}/[Gmail]/All Mail` })
    expect(normalizeEmail(allMail, providers, CONFIG)?.mailboxName).toBe("INBOX")
  })

  test("falls back from message id to document id to row id", () => {
    expect(normalizeEmail(row(), providers, CONFIG)?.id).toBe("40")
    expect(normalizeEmail(row({ messageIdText: null }), providers, CONFIG)?.id).toBe("doc-100")
    expect(normalizeEmail(row({ messageIdText: null, documentId: null }), providers, CONFIG)?.id).toBe("100")
  })

  test("builds a handle the mutation tools can address the message by", () => {
    const email = normalizeEmail(row(), providers, CONFIG)
    expect(email?.handle.mailboxUrl).toBe(INBOX)
    expect(email?.handle.mailId).toBe("100")
  })

  test("leaves the timestamps empty rather than inventing one", () => {
    const undated = normalizeEmail(row({ receivedAtUnix: null }), providers, CONFIG)
    expect(undated?.receivedAt).toBe("")
    expect(undated?.receivedAtLocal).toBe("")
  })
})

describe("matchesMailboxFilter", () => {
  const email = { mailboxName: "INBOX", mailboxUrl: INBOX } as NormalizedEmail

  test("matches case-insensitively on name or URL, and passes everything when unset", () => {
    expect(matchesMailboxFilter(email, undefined)).toBe(true)
    expect(matchesMailboxFilter(email, "inbox")).toBe(true)
    expect(matchesMailboxFilter(email, "imap.example.com")).toBe(true)
    expect(matchesMailboxFilter(email, "archive")).toBe(false)
  })
})

describe("toSearchBoundSeconds", () => {
  test("a bare date means local midnight, not UTC midnight", () => {
    // `new Date("2026-09-01")` is 17:00 on Aug 31 in Pacific time, so `after` used to include the
    // previous evening and `before` used to drop the last hours of the day.
    const local = new Date(2026, 8, 1, 0, 0, 0, 0)
    expect(toSearchBoundSeconds("2026-09-01")).toBe(Math.floor(local.getTime() / 1000))
    expect(new Date(toSearchBoundSeconds("2026-09-01") * 1000).getDate()).toBe(1)
    expect(new Date(toSearchBoundSeconds("2026-09-01") * 1000).getHours()).toBe(0)
  })

  test("an explicit zone is honoured rather than reinterpreted", () => {
    expect(toSearchBoundSeconds("2026-09-01T00:00:00Z")).toBe(Math.floor(Date.UTC(2026, 8, 1) / 1000))
  })

  test("a local timestamp without a zone keeps Date's own reading", () => {
    expect(toSearchBoundSeconds("2026-09-01T09:30:00")).toBe(Math.floor(new Date(2026, 8, 1, 9, 30).getTime() / 1000))
  })
})
