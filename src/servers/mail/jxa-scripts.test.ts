import { describe, expect, test } from "bun:test"

import * as scripts from "./jxa-scripts"

describe("mail JXA scripts", () => {
  test("every script parses as JavaScript", () => {
    const sources = Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    expect(sources.length).toBeGreaterThan(10)
    for (const [name, source] of sources) {
      // `name` in the message says which script failed to parse.
      expect(() => new Function(source), name).not.toThrow()
    }
  })
})

type Specifier = { exists: () => boolean }
type FakeMessage = Specifier & { id: number }
type FakeMailbox = Specifier & { messages: { byId: (id: number) => FakeMessage } }
type FakeAccount = Specifier & { mailboxes: { byName: (name: string) => FakeMailbox } }
type FakeMail = { accounts: { byId: (id: string) => FakeAccount } }
type Parts = { accountId: string; mailboxUrl: string; mailId: string; mailboxName: string; valid: boolean }

// The lookup prelude is plain JavaScript that runs inside osascript; evaluated here over fake Mail objects.
const { readHandle, findMessage } = new Function(
  `${scripts.MESSAGE_LOOKUP_JXA}; return { readHandle, findMessage }`,
)() as {
  readHandle: (handle: Record<string, unknown>) => Parts
  findMessage: (
    mail: FakeMail,
    parts: Parts,
  ) => { missing?: string; account?: FakeAccount; mailbox?: FakeMailbox; message?: FakeMessage }
}

const fakeMail = (has: { account?: boolean; mailbox?: boolean; message?: boolean }): FakeMail => ({
  accounts: {
    byId: () => ({
      exists: () => has.account !== false,
      mailboxes: {
        byName: () => ({
          exists: () => has.mailbox !== false,
          messages: { byId: (id) => ({ id, exists: () => has.message !== false }) },
        }),
      },
    }),
  },
})

describe("readHandle", () => {
  test("reads the handle and decodes the mailbox name", () => {
    expect(readHandle({ accountId: "A1", mailboxUrl: "imap://A1/Work%20Mail", mailId: "42" })).toEqual({
      accountId: "A1",
      mailboxUrl: "imap://A1/Work%20Mail",
      mailId: "42",
      mailboxName: "Work Mail",
      valid: true,
    })
  })

  test("is invalid when any part is missing, including a URL with no mailbox path", () => {
    expect(readHandle({ mailboxUrl: "imap://A1/INBOX", mailId: "42" }).valid).toBe(false)
    expect(readHandle({ accountId: "A1", mailboxUrl: "imap://A1", mailId: "42" }).valid).toBe(false)
    expect(readHandle({}).valid).toBe(false)
  })
})

describe("findMessage", () => {
  const parts = readHandle({ accountId: "A1", mailboxUrl: "imap://A1/INBOX", mailId: "42" })

  test("returns the message, its mailbox and account", () => {
    const found = findMessage(fakeMail({}), parts)
    expect(found.missing).toBeUndefined()
    expect(found.message?.id).toBe(42)
  })

  test("names the first missing piece", () => {
    expect(findMessage(fakeMail({ account: false }), parts).missing).toBe("account")
    expect(findMessage(fakeMail({ mailbox: false }), parts).missing).toBe("mailbox")
    expect(findMessage(fakeMail({ message: false }), parts).missing).toBe("message")
    expect(findMessage(fakeMail({ account: false, message: false }), parts).missing).toBe("account")
  })
})

type FakeAccountForSend = { enabled: () => boolean; emailAddresses: () => string[]; name: string }

const { chooseAccount } = new Function(`${scripts.SEND_EMAIL_JXA}; return { chooseAccount }`)() as {
  chooseAccount: (accounts: FakeAccountForSend[], from: string, warnings: string[]) => FakeAccountForSend | null
}

const account = (name: string, enabled: boolean | Error, addresses: string[] | Error): FakeAccountForSend => ({
  name,
  enabled: () => {
    if (enabled instanceof Error) throw enabled
    return enabled
  },
  emailAddresses: () => {
    if (addresses instanceof Error) throw addresses
    return addresses
  },
})

describe("chooseAccount", () => {
  test("without a from address, picks the first enabled account", () => {
    const warnings: string[] = []
    const accounts = [account("off", false, []), account("on", true, []), account("later", true, [])]
    expect(chooseAccount(accounts, "", warnings)?.name).toBe("on")
    expect(warnings).toEqual([])
  })

  test("matches a from address case-insensitively among enabled accounts", () => {
    const accounts = [account("off", false, ["me@example.com"]), account("on", true, ["Me@Example.com"])]
    expect(chooseAccount(accounts, "me@example.com", [])?.name).toBe("on")
  })

  test("an unreadable enabled state counts as enabled, and is reported", () => {
    const warnings: string[] = []
    const accounts = [account("unknown", new Error("Can't get object."), ["me@example.com"])]
    expect(chooseAccount(accounts, "me@example.com", warnings)?.name).toBe("unknown")
    expect(warnings).toEqual(["Could not read whether account 1 is enabled: Can't get object."])
  })

  test("unreadable addresses cannot match; the failure is reported and nothing is chosen", () => {
    const warnings: string[] = []
    const accounts = [account("broken", true, new Error("Can't get object."))]
    expect(chooseAccount(accounts, "me@example.com", warnings)).toBeNull()
    expect(warnings).toEqual(["Could not read account 1's addresses: Can't get object."])
  })
})
