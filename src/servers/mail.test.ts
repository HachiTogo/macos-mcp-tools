import { describe, expect, test } from "bun:test"

import {
  classifyAccountByMailboxUrl,
  createEmailHandle,
  formatEmailsForContent,
  formatMarkEmailsJunkSummary,
  formatMarkEmailsNotJunkSummary,
  formatMarkEmailsReadSummary,
  getMailboxAccountKey,
  parseMarkEmailsJunkArguments,
  parseMarkEmailsNotJunkArguments,
  parseMarkEmailsReadArguments,
  parseFetchEmailBodyArguments,
  type NormalizedEmail,
} from "./mail"

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
    expect(
      classifyAccountByMailboxUrl("imap://F56BB519-D39F-403E-AB6A-83A76BAE90CB/INBOX", TEST_CONFIG),
    ).toEqual({
      accountLabel: "SafeGraph",
      accountCategory: "work",
    })

    expect(
      classifyAccountByMailboxUrl("imap://F4F493BD-A783-40FE-B1CD-198F32F8A977/INBOX", TEST_CONFIG),
    ).toEqual({
      accountLabel: "HachiTogo",
      accountCategory: "personal",
    })

    expect(classifyAccountByMailboxUrl("imap://some-other-account/INBOX", TEST_CONFIG)).toEqual({
      accountLabel: "unknown",
      accountCategory: "unknown",
    })
  })

  test("creates stable message handles from mailbox URLs and Mail ids", () => {
    expect(
      createEmailHandle(
        "imap://F56BB519-D39F-403E-AB6A-83A76BAE90CB/INBOX",
        "101",
      ),
    ).toEqual({
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
    expect(() => parseMarkEmailsNotJunkArguments({ emails: [] })).toThrow(
      "expected at least one email",
    )
  })

  test("rejects missing emails field", () => {
    expect(() => parseMarkEmailsNotJunkArguments({})).toThrow()
  })

  test("rejects non-object email entries", () => {
    expect(() => parseMarkEmailsNotJunkArguments({ emails: ["not-an-object"] })).toThrow(
      "expected an object",
    )
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
