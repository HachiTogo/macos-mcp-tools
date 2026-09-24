import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"

import { MAILBOX_NAME_JXA } from "./jxa-scripts"
import { getMailboxAccountKey, getMailboxName } from "./mailbox"

// A read displays a mailbox by name and a mutation finds it by name, in TypeScript and in JXA
// respectively. When the two disagree the mailbox lists fine and then fails to mutate with
// `invalid_handle`, which is the kind of bug that never reproduces on the machine you test on.

const URLS = [
  "imap://user%40host@imap.gmail.com/INBOX",
  "imap://user%40host@imap.gmail.com/[Gmail]/All Mail",
  "imap://user%40host@imap.gmail.com/[Gmail]/Sent Mail",
  "imap://user%40host@imap.mail.me.com/Sent%20Messages",
  "ews://user@exchange.corp/Inbox/Team%2FProject",
  "imap://user%40host@imap.gmail.com/Work/2026/Q3",
  // The shapes the two implementations used to disagree on:
  "imap://user%40host@imap.gmail.com",
  "imap://user%40host@imap.gmail.com/",
  "imap://user%40host@imap.gmail.com/INBOX/",
  "imap://user%40host@imap.gmail.com/Work//Archive",
  "local://Drafts",
]

describe("getMailboxName", () => {
  test("is the URL path with each segment decoded", () => {
    expect(getMailboxName("imap://user%40host@imap.gmail.com/INBOX")).toBe("INBOX")
    expect(getMailboxName("imap://user%40host@imap.gmail.com/[Gmail]/All Mail")).toBe("[Gmail]/All Mail")
    expect(getMailboxName("imap://user%40host@imap.mail.me.com/Sent%20Messages")).toBe("Sent Messages")
  })

  test("a trailing or doubled slash does not change the name", () => {
    expect(getMailboxName("imap://h/INBOX/")).toBe("INBOX")
    expect(getMailboxName("imap://h/Work//Archive")).toBe("Work/Archive")
  })

  test("a URL with no path has no mailbox name", () => {
    expect(getMailboxName("imap://user%40host@imap.gmail.com")).toBe("")
    expect(getMailboxName("imap://user%40host@imap.gmail.com/")).toBe("")
  })

  test("leaves an undecodable segment alone rather than throwing", () => {
    expect(getMailboxName("imap://h/100%")).toBe("100%")
  })
})

describe("getMailboxAccountKey", () => {
  test("is the URL authority, which is what config is keyed by", () => {
    expect(getMailboxAccountKey("imap://user%40host@imap.gmail.com/INBOX")).toBe("user%40host@imap.gmail.com")
    expect(getMailboxAccountKey("local://Drafts")).toBe("Drafts")
  })
})

describe("the JXA copy of getMailboxName", () => {
  test("agrees with the TypeScript one on every URL shape", () => {
    // Runs the same prelude the mutation scripts carry, through the same interpreter they run in.
    // No application is addressed, so this needs no automation permission.
    const script = `${MAILBOX_NAME_JXA}
function run(argv) {
  return JSON.stringify(JSON.parse(argv[0]).map(getMailboxName))
}`
    const result = spawnSync("osascript", ["-l", "JavaScript", "-e", script, JSON.stringify(URLS)], {
      encoding: "utf8",
    })

    expect(result.status, `osascript failed: ${result.stderr}`).toBe(0)
    const fromJxa = JSON.parse(result.stdout.trim()) as string[]
    expect(fromJxa).toEqual(URLS.map(getMailboxName))
  })
})
