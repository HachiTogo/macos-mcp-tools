import { describe, expect, test } from "bun:test"

import {
  parseExtractEmailLinksArguments,
  parseFetchEmailBodyArguments,
  parseForwardEmailArguments,
  parseMarkEmailsJunkArguments,
  parseMarkEmailsNotJunkArguments,
  parseMarkEmailsReadArguments,
  parseReplyEmailArguments,
  parseSendEmailArguments,
} from "./mail"
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
      { limit: 10 },
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
  test("parses fetched email objects into mark-read targets", () => {
    expect(
      parseMarkEmailsReadArguments({
        emails: [
          createEmail({
            id: "message-1@example.com",
            subject: "Status update",
            handle: createEmailHandle("imap://account/INBOX", "101"),
          }),
        ],
      }),
    ).toEqual({
      emails: [
        {
          id: "message-1@example.com",
          subject: "Status update",
          handle: {
            accountId: "account",
            mailboxUrl: "imap://account/INBOX",
            mailId: "101",
          },
        },
      ],
    })
  })

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

describe("mark emails junk argument parsing", () => {
  test("parses valid junk arguments with handle", () => {
    const result = parseMarkEmailsJunkArguments({
      emails: [
        {
          id: "msg-1",
          subject: "You won a prize!",
          handle: {
            accountId: "F56BB519-D39F-403E-AB6A-83A76BAE90CB",
            mailboxUrl: "imap://F56BB519-D39F-403E-AB6A-83A76BAE90CB/INBOX",
            mailId: "42",
          },
        },
      ],
    })

    expect(result.emails).toHaveLength(1)
    expect(result.emails[0].id).toBe("msg-1")
    expect(result.emails[0].subject).toBe("You won a prize!")
    expect(result.emails[0].handle.accountId).toBe("F56BB519-D39F-403E-AB6A-83A76BAE90CB")
    expect(result.emails[0].handle.mailId).toBe("42")
  })

  test("assigns default id when not provided", () => {
    const result = parseMarkEmailsJunkArguments({
      emails: [
        {
          handle: {
            accountId: "acct-1",
            mailboxUrl: "imap://acct-1/INBOX",
            mailId: "99",
          },
        },
      ],
    })

    expect(result.emails[0].id).toBe("email-1")
  })

  test("rejects empty emails array", () => {
    expect(() => parseMarkEmailsJunkArguments({ emails: [] })).toThrow("expected at least one email")
  })

  test("rejects missing emails field", () => {
    expect(() => parseMarkEmailsJunkArguments({})).toThrow()
  })

  test("rejects non-object email entries", () => {
    expect(() => parseMarkEmailsJunkArguments({ emails: ["not-an-object"] })).toThrow()
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

describe("fetch email body helpers", () => {
  test("parses valid handle into fetch arguments", () => {
    expect(
      parseFetchEmailBodyArguments({
        handle: {
          accountId: "F56BB519-D39F-403E-AB6A-83A76BAE90CB",
          mailboxUrl: "imap://F56BB519-D39F-403E-AB6A-83A76BAE90CB/INBOX",
          mailId: "42",
        },
      }),
    ).toEqual({
      handle: {
        accountId: "F56BB519-D39F-403E-AB6A-83A76BAE90CB",
        mailboxUrl: "imap://F56BB519-D39F-403E-AB6A-83A76BAE90CB/INBOX",
        mailId: "42",
      },
    })
  })

  test("rejects missing handle", () => {
    expect(() => parseFetchEmailBodyArguments({})).toThrow("Invalid handle")
  })

  test("rejects handle missing required fields", () => {
    expect(() =>
      parseFetchEmailBodyArguments({
        handle: { accountId: "abc", mailboxUrl: "imap://abc/INBOX" },
      }),
    ).toThrow("Invalid handle")
  })

  test("rejects unexpected top-level fields", () => {
    expect(() =>
      parseFetchEmailBodyArguments({
        handle: {
          accountId: "abc",
          mailboxUrl: "imap://abc/INBOX",
          mailId: "1",
        },
        extra: "bad",
      }),
    ).toThrow()
  })
})

describe("mark emails not-junk argument parsing", () => {
  test("parses valid not-junk arguments with handle", () => {
    const result = parseMarkEmailsNotJunkArguments({
      emails: [
        {
          id: "msg-1",
          subject: "Test",
          handle: {
            accountId: "acc-1",
            mailboxUrl: "imap://user@host/INBOX",
            mailId: "12345",
          },
        },
      ],
    })

    expect(result.emails).toHaveLength(1)
    expect(result.emails[0].id).toBe("msg-1")
    expect(result.emails[0].subject).toBe("Test")
    expect(result.emails[0].handle.accountId).toBe("acc-1")
  })

  test("assigns default id when not provided", () => {
    const result = parseMarkEmailsNotJunkArguments({
      emails: [
        {
          handle: {
            accountId: "acc-1",
            mailboxUrl: "imap://user@host/INBOX",
            mailId: "12345",
          },
        },
      ],
    })

    expect(result.emails[0].id).toBe("email-1")
  })

  test("rejects empty emails array", () => {
    expect(() => parseMarkEmailsNotJunkArguments({ emails: [] })).toThrow("expected at least one email")
  })

  test("rejects missing emails field", () => {
    expect(() => parseMarkEmailsNotJunkArguments({})).toThrow()
  })

  test("rejects non-object email entries", () => {
    expect(() => parseMarkEmailsNotJunkArguments({ emails: ["not-an-object"] })).toThrow("expected an object")
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
  test("parses valid handle into extract arguments", () => {
    expect(
      parseExtractEmailLinksArguments({
        handle: {
          accountId: "F56BB519-D39F-403E-AB6A-83A76BAE90CB",
          mailboxUrl: "imap://F56BB519-D39F-403E-AB6A-83A76BAE90CB/INBOX",
          mailId: "42",
        },
      }),
    ).toEqual({
      handle: {
        accountId: "F56BB519-D39F-403E-AB6A-83A76BAE90CB",
        mailboxUrl: "imap://F56BB519-D39F-403E-AB6A-83A76BAE90CB/INBOX",
        mailId: "42",
      },
    })
  })

  test("rejects missing handle", () => {
    expect(() => parseExtractEmailLinksArguments({})).toThrow("Invalid handle")
  })

  test("rejects handle missing required fields", () => {
    expect(() =>
      parseExtractEmailLinksArguments({
        handle: { accountId: "abc", mailboxUrl: "imap://abc/INBOX" },
      }),
    ).toThrow("Invalid handle")
  })

  test("rejects unexpected top-level fields", () => {
    expect(() =>
      parseExtractEmailLinksArguments({
        handle: {
          accountId: "abc",
          mailboxUrl: "imap://abc/INBOX",
          mailId: "1",
        },
        extra: "bad",
      }),
    ).toThrow()
  })

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

describe("send email argument parsing", () => {
  test("accepts valid send arguments", () => {
    const result = parseSendEmailArguments({
      to: ["alice@example.com"],
      subject: "Hello",
      body: "Body text",
    })
    expect(result.to).toEqual(["alice@example.com"])
    expect(result.subject).toBe("Hello")
    expect(result.body).toBe("Body text")
    expect(result.cc).toBeUndefined()
    expect(result.bcc).toBeUndefined()
    expect(result.from).toBeUndefined()
  })

  test("accepts optional cc, bcc, from", () => {
    const result = parseSendEmailArguments({
      to: ["alice@example.com"],
      cc: ["carl@example.com"],
      bcc: ["bert@example.com"],
      subject: "Hello",
      body: "Body text",
      from: "me@example.com",
    })
    expect(result.cc).toEqual(["carl@example.com"])
    expect(result.bcc).toEqual(["bert@example.com"])
    expect(result.from).toBe("me@example.com")
  })

  test("rejects empty 'to' array", () => {
    expect(() => parseSendEmailArguments({ to: [], subject: "Hi", body: "Body" })).toThrow("at least one")
  })

  test("rejects missing 'to' field", () => {
    expect(() => parseSendEmailArguments({ subject: "Hi", body: "Body" })).toThrow("non-empty array")
  })

  test("rejects invalid email format in 'to'", () => {
    expect(() =>
      parseSendEmailArguments({
        to: ["not-an-email"],
        subject: "Hi",
        body: "Body",
      }),
    ).toThrow("valid email address")
  })

  test("rejects invalid email format in 'cc'", () => {
    expect(() =>
      parseSendEmailArguments({
        to: ["alice@example.com"],
        cc: ["bad@@email"],
        subject: "Hi",
        body: "Body",
      }),
    ).toThrow("valid email address")
  })

  test("rejects empty subject", () => {
    expect(() => parseSendEmailArguments({ to: ["alice@example.com"], subject: "", body: "Body" })).toThrow("subject")
  })

  test("rejects empty body", () => {
    expect(() => parseSendEmailArguments({ to: ["alice@example.com"], subject: "Hi", body: "" })).toThrow("body")
  })

  test("rejects bad 'from' email format", () => {
    expect(() =>
      parseSendEmailArguments({
        to: ["alice@example.com"],
        subject: "Hi",
        body: "Body",
        from: "not-an-email",
      }),
    ).toThrow("from")
  })
})

describe("reply email argument parsing", () => {
  const validHandle = {
    accountId: "F56BB519-D39F-403E-AB6A-83A76BAE90CB",
    mailboxUrl: "imap://F56BB519-D39F-403E-AB6A-83A76BAE90CB/INBOX",
    mailId: "42",
  }

  test("accepts valid reply arguments", () => {
    const result = parseReplyEmailArguments({
      handle: validHandle,
      body: "Thanks!",
    })
    expect(result.handle.accountId).toBe(validHandle.accountId)
    expect(result.body).toBe("Thanks!")
    expect(result.replyAll).toBeUndefined()
    expect(result.from).toBeUndefined()
  })

  test("accepts optional replyAll and from", () => {
    const result = parseReplyEmailArguments({
      handle: validHandle,
      body: "Thanks!",
      replyAll: true,
      from: "me@example.com",
    })
    expect(result.replyAll).toBe(true)
    expect(result.from).toBe("me@example.com")
  })

  test("rejects missing handle", () => {
    expect(() => parseReplyEmailArguments({ body: "Hi" })).toThrow("handle")
  })

  test("rejects handle missing fields", () => {
    expect(() =>
      parseReplyEmailArguments({
        handle: { accountId: "x", mailboxUrl: "y" },
        body: "Hi",
      }),
    ).toThrow("handle")
  })

  test("rejects empty body", () => {
    expect(() => parseReplyEmailArguments({ handle: validHandle, body: "" })).toThrow("body")
  })

  test("rejects non-boolean replyAll", () => {
    expect(() => parseReplyEmailArguments({ handle: validHandle, body: "Hi", replyAll: "yes" })).toThrow("replyAll")
  })

  test("rejects bad 'from' email format", () => {
    expect(() =>
      parseReplyEmailArguments({
        handle: validHandle,
        body: "Hi",
        from: "not-an-email",
      }),
    ).toThrow("from")
  })
})

describe("forward email argument parsing", () => {
  const validHandle = {
    accountId: "F56BB519-D39F-403E-AB6A-83A76BAE90CB",
    mailboxUrl: "imap://F56BB519-D39F-403E-AB6A-83A76BAE90CB/INBOX",
    mailId: "42",
  }

  test("accepts valid forward arguments", () => {
    const result = parseForwardEmailArguments({
      handle: validHandle,
      to: ["alice@example.com"],
    })
    expect(result.handle.accountId).toBe(validHandle.accountId)
    expect(result.to).toEqual(["alice@example.com"])
    expect(result.body).toBeUndefined()
  })

  test("accepts optional body, cc, bcc, from", () => {
    const result = parseForwardEmailArguments({
      handle: validHandle,
      to: ["alice@example.com"],
      cc: ["carl@example.com"],
      bcc: ["bert@example.com"],
      body: "FYI",
      from: "me@example.com",
    })
    expect(result.body).toBe("FYI")
    expect(result.cc).toEqual(["carl@example.com"])
    expect(result.bcc).toEqual(["bert@example.com"])
    expect(result.from).toBe("me@example.com")
  })

  test("rejects empty 'to' array", () => {
    expect(() => parseForwardEmailArguments({ handle: validHandle, to: [] })).toThrow("at least one")
  })

  test("rejects missing 'to' field", () => {
    expect(() => parseForwardEmailArguments({ handle: validHandle })).toThrow("non-empty array")
  })

  test("rejects invalid email format in 'to'", () => {
    expect(() =>
      parseForwardEmailArguments({
        handle: validHandle,
        to: ["not-an-email"],
      }),
    ).toThrow("valid email address")
  })

  test("rejects missing handle", () => {
    expect(() => parseForwardEmailArguments({ to: ["alice@example.com"] })).toThrow("handle")
  })

  test("rejects bad 'from' email format", () => {
    expect(() =>
      parseForwardEmailArguments({
        handle: validHandle,
        to: ["alice@example.com"],
        from: "not-an-email",
      }),
    ).toThrow("from")
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
