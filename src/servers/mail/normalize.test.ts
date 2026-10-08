import { describe, expect, test } from "bun:test"

import {
  filedGmailLabels,
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

/** What unread_emails passes: archived Gmail mail is left out. */
const UNREAD = { includeArchivedGmail: false }
/** What search_emails passes: archived Gmail mail is still searchable. */
const SEARCH = { includeArchivedGmail: true }

describe("normalizeEmail", () => {
  const providers = new Map<string, "gmail" | "icloud">([[ACCOUNT, "gmail"]])

  test("carries the account classification from config", () => {
    const email = normalizeEmail(row(), providers, CONFIG, UNREAD)
    expect(email?.accountLabel).toBe("Work")
    expect(email?.accountCategory).toBe("work")
    expect(email?.provider).toBe("gmail")
  })

  test("drops rows with no mailbox URL and rows in excluded mailboxes", () => {
    expect(normalizeEmail(row({ mailboxUrl: null }), providers, CONFIG, UNREAD)).toBeUndefined()
    const junk = row({ mailboxUrl: `imap://${ACCOUNT}/[Gmail]/Spam` })
    expect(normalizeEmail(junk, providers, CONFIG, UNREAD)).toBeUndefined()
  })

  test("falls back from message id to document id to row id", () => {
    expect(normalizeEmail(row(), providers, CONFIG, UNREAD)?.id).toBe("40")
    expect(normalizeEmail(row({ messageIdText: null }), providers, CONFIG, UNREAD)?.id).toBe("doc-100")
    expect(normalizeEmail(row({ messageIdText: null, documentId: null }), providers, CONFIG, UNREAD)?.id).toBe("100")
  })

  test("builds a handle the mutation tools can address the message by", () => {
    const email = normalizeEmail(row(), providers, CONFIG, UNREAD)
    expect(email?.handle.mailboxUrl).toBe(INBOX)
    expect(email?.handle.mailId).toBe("100")
  })

  test("leaves the timestamps empty rather than inventing one", () => {
    const undated = normalizeEmail(row({ receivedAtUnix: null }), providers, CONFIG, UNREAD)
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

// Gmail stores every message in [Gmail]/All Mail and files it with labels. The storage mailbox says
// nothing about where a message is filed, so the labels decide: INBOX or a user label means filed,
// none means archived. Gmail's own system labels (Important, Starred) do not count as filing.
describe("Gmail labels", () => {
  const GMAIL = "imap://9F1C2D3E-0000-4000-8000-000000000001"
  const at = (path: string) => `${GMAIL}/${path}`
  const ALL_MAIL = at("%5BGmail%5D/All%20Mail")
  const providers = new Map<string, "gmail" | "icloud">()
  const gmailRow = (...labelPaths: string[]) =>
    row({ mailboxUrl: ALL_MAIL, labelMailboxUrls: labelPaths.map(at).join("\n") || null })

  test("a message labelled INBOX is reported as INBOX, even without a provider in config", () => {
    const email = normalizeEmail(gmailRow("INBOX"), providers, CONFIG, UNREAD)
    expect(email?.mailboxName).toBe("INBOX")
    expect(email?.provider).toBe("gmail")
  })

  test("an unread message in a user label but not the inbox is kept, under that label", () => {
    const email = normalizeEmail(gmailRow("Newsletters"), providers, CONFIG, UNREAD)
    expect(email?.mailboxName).toBe("Newsletters")
    expect(email?.labels).toEqual(["Newsletters"])
  })

  test("archived mail, with no label at all, is left out of unread but stays searchable", () => {
    expect(normalizeEmail(gmailRow(), providers, CONFIG, UNREAD)).toBeUndefined()
    expect(normalizeEmail(gmailRow(), providers, CONFIG, SEARCH)?.mailboxName).toBe("[Gmail]/All Mail")
  })

  test("Gmail's own labels do not make a message filed", () => {
    // Gmail marks archived mail Important on its own; that must not pull it back into unread.
    expect(normalizeEmail(gmailRow("%5BGmail%5D/Important"), providers, CONFIG, UNREAD)).toBeUndefined()
    expect(normalizeEmail(gmailRow("%5BGmail%5D/Starred"), providers, CONFIG, UNREAD)).toBeUndefined()
  })

  test("INBOX wins when a message is also in a label, and the label still matches a filter", () => {
    const email = normalizeEmail(gmailRow("Receipts", "INBOX", "%5BGmail%5D/Important"), providers, CONFIG, UNREAD)
    expect(email?.mailboxName).toBe("INBOX")
    expect(email?.labels).toEqual(["INBOX", "Receipts"])
    expect(email && matchesMailboxFilter(email, "receipts")).toBe(true)
    expect(email && matchesMailboxFilter(email, "inbox")).toBe(true)
  })

  test("the handle keeps pointing where the message is stored, which is where Mail.app finds it", () => {
    const email = normalizeEmail(gmailRow("Newsletters"), providers, CONFIG, UNREAD)
    expect(email?.handle.mailboxUrl).toBe(ALL_MAIL)
    expect(email?.mailboxUrl).toBe(at("Newsletters"))
  })

  test("Google Mail, the name Gmail uses in some regions, is handled the same way", () => {
    const row2 = row({ mailboxUrl: `${GMAIL}/%5BGoogle%20Mail%5D/All%20Mail`, labelMailboxUrls: at("INBOX") })
    expect(normalizeEmail(row2, providers, CONFIG, UNREAD)?.mailboxName).toBe("INBOX")
  })

  test("non-Gmail mailboxes are untouched: no labels field, reported where they are stored", () => {
    const email = normalizeEmail(row(), providers, CONFIG, UNREAD)
    expect(email?.mailboxName).toBe("INBOX")
    expect(email?.labels).toBeUndefined()
  })

  test("filedGmailLabels ignores blanks and system labels, and puts INBOX first", () => {
    expect(filedGmailLabels(null)).toEqual([])
    expect(
      filedGmailLabels(`${at("Zed")}\n\n${at("%5BGmail%5D/Important")}\n${at("INBOX")}`).map((l) => l.name),
    ).toEqual(["INBOX", "Zed"])
  })
})
