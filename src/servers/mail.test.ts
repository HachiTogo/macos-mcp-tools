import { describe, expect, test } from "bun:test"

import {
  formatEmailsForContent,
  formatMarkEmailsJunkSummary,
  formatMarkEmailsNotJunkSummary,
  formatMarkEmailsReadSummary,
  groupEmailsByAccount,
} from "./mail/format"
import { classifyAccountByMailboxUrl, createEmailHandle, getMailboxAccountKey, isExcludedMailbox } from "./mail/mailbox"
import { isBatchFailure } from "./mail/mutate"
import { extractLinksFromSource } from "./mail/read"
import type { NormalizedEmail } from "./mail/types"

const TEST_CONFIG = {
  accounts: {
    "F56BB519-D39F-403E-AB6A-83A76BAE90CB": {
      label: "SafeGraph",
      category: "work",
      provider: "gmail" as const,
    },
    "F4F493BD-A783-40FE-B1CD-198F32F8A977": {
      label: "HachiTogo",
      category: "personal",
      provider: "icloud" as const,
    },
  },
  displayOrder: ["SafeGraph", "HachiTogo"],
}

const createEmail = (overrides: Partial<NormalizedEmail>): NormalizedEmail => ({
  id: overrides.id ?? "message-1",
  handle: overrides.handle ?? createEmailHandle("imap://account/INBOX", "101"),
  subject: overrides.subject ?? "Status update",
  senderName: overrides.senderName ?? "Pat Example",
  senderAddress: overrides.senderAddress ?? "pat@example.com",
  mailboxName: overrides.mailboxName ?? "INBOX",
  mailboxUrl: overrides.mailboxUrl ?? "imap://account/INBOX",
  provider: overrides.provider ?? "icloud",
  accountLabel: overrides.accountLabel ?? "unknown",
  accountCategory: overrides.accountCategory ?? "unknown",
  receivedAt: overrides.receivedAt ?? "2026-03-14T12:00:00.000Z",
  receivedAtLocal: overrides.receivedAtLocal ?? "2026-03-14T08:00:00",
  isUnread: overrides.isUnread ?? true,
  messageUrl: overrides.messageUrl ?? "",
  source: overrides.source ?? "Apple Mail Envelope Index",
})

describe("email mailbox classification", () => {
  test("extracts mailbox account keys from Apple Mail URLs", () => {
    expect(getMailboxAccountKey("imap://F56BB519-D39F-403E-AB6A-83A76BAE90CB/INBOX")).toBe(
      "F56BB519-D39F-403E-AB6A-83A76BAE90CB",
    )
    expect(getMailboxAccountKey("not-a-mailbox-url")).toBe("not-a-mailbox-url")
  })

  test("classifies SafeGraph, HachiTogo, and unknown accounts", () => {
    expect(classifyAccountByMailboxUrl("imap://F56BB519-D39F-403E-AB6A-83A76BAE90CB/INBOX", TEST_CONFIG)).toEqual({
      accountLabel: "SafeGraph",
      accountCategory: "work",
    })

    expect(classifyAccountByMailboxUrl("imap://F4F493BD-A783-40FE-B1CD-198F32F8A977/INBOX", TEST_CONFIG)).toEqual({
      accountLabel: "HachiTogo",
      accountCategory: "personal",
    })

    expect(classifyAccountByMailboxUrl("imap://some-other-account/INBOX", TEST_CONFIG)).toEqual({
      accountLabel: "unknown",
      accountCategory: "unknown",
    })
  })

  test("creates stable message handles from mailbox URLs and Mail ids", () => {
    expect(createEmailHandle("imap://F56BB519-D39F-403E-AB6A-83A76BAE90CB/INBOX", "101")).toEqual({
      accountId: "F56BB519-D39F-403E-AB6A-83A76BAE90CB",
      mailboxUrl: "imap://F56BB519-D39F-403E-AB6A-83A76BAE90CB/INBOX",
      mailId: "101",
    })
  })
})

describe("email content formatting", () => {
  test("groups unread emails by account label/category in display order", () => {
    const content = formatEmailsForContent(
      [
        createEmail({
          id: "unknown-1",
          accountLabel: "unknown",
          accountCategory: "unknown",
          senderName: "Marketing Team",
          subject: "Spring newsletter",
          mailboxName: "Newsletters",
        }),
        createEmail({
          id: "safegraph-1",
          accountLabel: "SafeGraph",
          accountCategory: "work",
          senderName: "Avery Analyst",
          subject: "Quarterly planning",
          mailboxName: "INBOX",
        }),
        createEmail({
          id: "hachi-1",
          accountLabel: "HachiTogo",
          accountCategory: "personal",
          senderName: "Sam Friend",
          subject: "Dinner plans",
          mailboxName: "Personal/Inbox",
        }),
      ],
      { limit: 10, offset: 0 },
      TEST_CONFIG,
    )

    expect(content).toContain("Found 3 unread emails.")
    expect(content).toContain("SafeGraph (work) — 1 unread")
    expect(content).toContain("HachiTogo (personal) — 1 unread")
    expect(content).toContain("unknown (unknown) — 1 unread")
    expect(content).toContain("Avery Analyst — Quarterly planning (INBOX)")
    expect(content).toContain("Sam Friend — Dinner plans (Personal/Inbox)")
    expect(content).toContain("Marketing Team — Spring newsletter (Newsletters)")

    expect(content.indexOf("SafeGraph (work) — 1 unread")).toBeLessThan(
      content.indexOf("HachiTogo (personal) — 1 unread"),
    )
    expect(content.indexOf("HachiTogo (personal) — 1 unread")).toBeLessThan(
      content.indexOf("unknown (unknown) — 1 unread"),
    )
  })
})

describe("mark emails read helpers", () => {
  test("formats concise mark-read summaries", () => {
    expect(
      formatMarkEmailsReadSummary([
        {
          id: "1",
          handle: createEmailHandle("imap://account/INBOX", "1"),
          status: "marked_read",
        },
        {
          id: "2",
          handle: createEmailHandle("imap://account/INBOX", "2"),
          status: "already_read",
        },
        {
          id: "3",
          handle: createEmailHandle("imap://account/INBOX", "3"),
          status: "not_found",
        },
      ]),
    ).toBe("Processed 3 emails; 1 marked read; 1 already read; 1 not found.")
  })
})

describe("mark emails junk summary formatting", () => {
  test("formats single marked junk result", () => {
    const summary = formatMarkEmailsJunkSummary([
      {
        id: "msg-1",
        handle: createEmailHandle("imap://acct/INBOX", "42"),
        status: "marked_junk",
      },
    ])

    expect(summary).toContain("1 marked junk")
  })

  test("formats mixed results", () => {
    const summary = formatMarkEmailsJunkSummary([
      {
        id: "msg-1",
        handle: createEmailHandle("imap://acct/INBOX", "42"),
        status: "marked_junk",
      },
      {
        id: "msg-2",
        handle: createEmailHandle("imap://acct/INBOX", "43"),
        status: "already_junk",
      },
      {
        id: "msg-3",
        handle: createEmailHandle("imap://acct/INBOX", "44"),
        status: "no_junk_mailbox",
      },
    ])

    expect(summary).toContain("Processed 3 emails")
    expect(summary).toContain("1 marked junk")
    expect(summary).toContain("1 already junk")
    expect(summary).toContain("1 no junk mailbox")
  })
})

describe("mark emails not-junk summary formatting", () => {
  test("formats single marked not-junk result", () => {
    const summary = formatMarkEmailsNotJunkSummary([
      {
        id: "msg-1",
        handle: { accountId: "a", mailboxUrl: "u", mailId: "1" },
        status: "marked_not_junk",
      },
    ])

    expect(summary).toContain("1 marked not junk")
  })

  test("formats mixed results", () => {
    const summary = formatMarkEmailsNotJunkSummary([
      {
        id: "msg-1",
        handle: { accountId: "a", mailboxUrl: "u", mailId: "1" },
        status: "marked_not_junk",
      },
      {
        id: "msg-2",
        handle: { accountId: "a", mailboxUrl: "u", mailId: "2" },
        status: "already_not_junk",
      },
      {
        id: "msg-3",
        handle: { accountId: "a", mailboxUrl: "u", mailId: "3" },
        status: "no_inbox_mailbox",
      },
    ])

    expect(summary).toContain("Processed 3 emails")
    expect(summary).toContain("1 marked not junk")
    expect(summary).toContain("1 already not junk")
    expect(summary).toContain("1 no inbox mailbox")
  })
})

describe("extract email links helpers", () => {
  test("extracts links from a plain HTML part", () => {
    const source = [
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<html><body><a href="https://example.com/one">One</a> and <a href="https://example.com/two">Two</a></body></html>',
    ].join("\r\n")

    const { links, truncated } = extractLinksFromSource(source)

    expect(truncated).toBe(false)
    expect(links).toEqual([
      { url: "https://example.com/one", text: "One" },
      { url: "https://example.com/two", text: "Two" },
    ])
  })

  test("decodes quoted-printable HTML part", () => {
    const source = [
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      '<a href=3D"https://example.com/path?a=3D1&b=3D=\r\n2">Click =\r\nhere</a>',
    ].join("\r\n")

    const { links } = extractLinksFromSource(source)

    expect(links).toEqual([{ url: "https://example.com/path?a=1&b=2", text: "Click here" }])
  })

  test("falls back to bare URL extraction for text/plain only", () => {
    const source = [
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Visit https://example.com/a or https://example.com/b for details.",
    ].join("\r\n")

    const { links } = extractLinksFromSource(source)

    expect(links).toEqual([
      { url: "https://example.com/a", text: "https://example.com/a" },
      { url: "https://example.com/b", text: "https://example.com/b" },
    ])
  })

  test("skips mailto, javascript, and hash anchors", () => {
    const source = [
      "Content-Type: text/html; charset=utf-8",
      "",
      '<a href="mailto:x@y.com">x</a><a href="#top">top</a><a href="javascript:void(0)">x</a><a href="https://example.com/keep">keep</a>',
    ].join("\r\n")

    const { links } = extractLinksFromSource(source)

    expect(links).toEqual([{ url: "https://example.com/keep", text: "keep" }])
  })

  test("strips nested tags and collapses whitespace in anchor text", () => {
    const source = [
      "Content-Type: text/html; charset=utf-8",
      "",
      '<a href="https://example.com/X"><span>Click   <b>here</b></span></a>',
    ].join("\r\n")

    const { links } = extractLinksFromSource(source)

    expect(links).toEqual([{ url: "https://example.com/X", text: "Click here" }])
  })

  test("decodes HTML entities in anchor text", () => {
    const source = ["Content-Type: text/html; charset=utf-8", "", '<a href="https://example.com/X">A &amp; B</a>'].join(
      "\r\n",
    )

    const { links } = extractLinksFromSource(source)

    expect(links).toEqual([{ url: "https://example.com/X", text: "A & B" }])
  })

  test("truncates when link count exceeds MAX_LINKS", () => {
    const anchors = Array.from({ length: 600 }, (_, i) => `<a href="https://example.com/${i}">Link ${i}</a>`).join("")
    const source = ["Content-Type: text/html; charset=utf-8", "", `<html><body>${anchors}</body></html>`].join("\r\n")

    const { links, truncated } = extractLinksFromSource(source)

    expect(truncated).toBe(true)
    expect(links).toHaveLength(500)
    expect(links[0]).toEqual({ url: "https://example.com/0", text: "Link 0" })
    expect(links[499]).toEqual({ url: "https://example.com/499", text: "Link 499" })
  })
})

describe("mailbox exclusion", () => {
  test("excludes top-level junk, spam, trash, drafts and outbox mailboxes", () => {
    for (const name of ["Junk", "Spam", "Trash", "Drafts", "Outbox", "Deleted Messages", "Sent Messages"]) {
      expect(isExcludedMailbox(`imap://acct/${name}`, name, "icloud")).toBe(true)
    }
  })

  test("excludes nested provider mailboxes and prefix-named variants", () => {
    expect(isExcludedMailbox("imap://acct/[Gmail]/Spam", "[Gmail]/Spam", "gmail")).toBe(true)
    expect(isExcludedMailbox("imap://acct/INBOX/Junk E-mail", "INBOX/Junk E-mail", "icloud")).toBe(true)
    expect(isExcludedMailbox("imap://acct/[Gmail]", "[Gmail]", "gmail")).toBe(true)
  })

  test("keeps inbox and user folders", () => {
    expect(isExcludedMailbox("imap://acct/INBOX", "INBOX", "icloud")).toBe(false)
    expect(isExcludedMailbox("imap://acct/Receipts", "Receipts", "icloud")).toBe(false)
    expect(isExcludedMailbox("imap://acct/Projects/Trashcan Redesign", "Projects/Trashcan Redesign", "icloud")).toBe(
      true,
    )
  })

  test("excludes All Mail only for non-Gmail providers", () => {
    expect(isExcludedMailbox("imap://acct/All Mail", "All Mail", "icloud")).toBe(true)
    expect(isExcludedMailbox("imap://acct/[Gmail]/All Mail", "[Gmail]/All Mail", "gmail")).toBe(false)
  })
})

describe("account grouping order", () => {
  test("orders configured labels first, then unknown labels alphabetically, with an empty displayOrder", () => {
    const emails = [
      createEmail({ id: "z", accountLabel: "Zeta", accountCategory: "personal" }),
      createEmail({ id: "a", accountLabel: "Alpha", accountCategory: "work" }),
      createEmail({ id: "m", accountLabel: "Mid", accountCategory: "work" }),
    ]
    const groups = groupEmailsByAccount(emails, { accounts: {}, displayOrder: [] })
    expect(groups.map((group) => group.accountLabel)).toEqual(["Alpha", "Mid", "Zeta"])

    const ordered = groupEmailsByAccount(emails, { accounts: {}, displayOrder: ["Zeta"] })
    expect(ordered.map((group) => group.accountLabel)).toEqual(["Zeta", "Alpha", "Mid"])
  })
})

describe("batch mutation error reporting", () => {
  test("is an error only when every item failed", () => {
    expect(isBatchFailure([{ status: "not_found" }, { status: "invalid_handle" }])).toBe(true)
    expect(isBatchFailure([{ status: "error" }])).toBe(true)
    expect(isBatchFailure([{ status: "not_found" }, { status: "marked_read" }])).toBe(false)
    expect(isBatchFailure([{ status: "already_read" }])).toBe(false)
    expect(isBatchFailure([])).toBe(false)
  })
})
