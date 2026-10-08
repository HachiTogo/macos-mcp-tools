import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getMailboxName } from "./mailbox"
import { buildMailboxInventoryQuery, buildUnreadMessagesQuery, getSchemaInfo } from "./queries"
import { describeMailAccounts, runUnreadEmailRead, summarizeMailAccounts } from "./read"

// Provider and mailbox filters are applied in JavaScript, because they depend on the account
// config and on decoded mailbox names. This used to mean: read the newest 250 messages, filter
// those, return what survived. A filter matching nothing in that window reported "no unread
// emails" while plenty actually matched.

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mail-read-"))
  process.env.MACOS_TOOLS_DATA_DIR = dataDir
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env.MACOS_TOOLS_DATA_DIR
})

const NOISY = "imap://noisy%40example.com@imap.example.com"
const QUIET = "imap://quiet%40example.com@imap.example.com"

/** `noisy` unread messages in one account, then `quiet` older ones in another. */
const seed = (noisy: number, quiet: number) => {
  const db = new Database(":memory:")
  db.run(`
    CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);
    CREATE TABLE messages (
      ROWID INTEGER PRIMARY KEY, mailbox INTEGER, read INTEGER, deleted INTEGER,
      subject INTEGER, sender INTEGER, message_id INTEGER, date_received INTEGER
    );
    CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
    INSERT INTO mailboxes (ROWID, url) VALUES (1, '${NOISY}/INBOX'), (2, '${QUIET}/INBOX');
    INSERT INTO subjects (ROWID, subject) VALUES (1, 'Noise'), (2, 'Signal');
  `)
  const base = Math.floor(Date.UTC(2026, 8, 20) / 1000)
  const insert = db.prepare(
    "INSERT INTO messages (ROWID, mailbox, read, deleted, subject, sender, message_id, date_received) VALUES (?, ?, 0, 0, ?, NULL, ?, ?)",
  )
  let id = 1
  // Newest first by date, so the noisy account fills any leading window.
  for (let i = 0; i < noisy; i++, id++) insert.run(id, 1, 1, id, base - i)
  for (let i = 0; i < quiet; i++, id++) insert.run(id, 2, 2, id, base - noisy - i)
  return db
}

const read = (db: Database, args: Partial<{ limit: number; offset: number; mailbox: string }> = {}) =>
  runUnreadEmailRead(db, { limit: 25, offset: 0, ...args })

const structured = (result: ReturnType<typeof read>) =>
  result.structuredContent as { messages: { id: string; mailboxUrl: string }[] }

describe("runUnreadEmailRead", () => {
  test("finds matches past the first page of rows", () => {
    // 400 newer messages in another account: the five that match sit well outside the newest 250.
    const db = seed(400, 5)

    // What the old single-page read saw: one window of 250 rows, none of them from `quiet`.
    const firstWindow = db.query(buildUnreadMessagesQuery(getSchemaInfo(db), { limit: 250, offset: 0 })).all() as {
      mailboxUrl: string
    }[]
    expect(firstWindow.filter((row) => row.mailboxUrl.includes("quiet"))).toEqual([])

    const messages = structured(read(db, { mailbox: "quiet" })).messages
    expect(messages).toHaveLength(5)
    for (const message of messages) expect(message.mailboxUrl).toContain("quiet")
  })

  test("offset pages through matches without repeating one", () => {
    const db = seed(0, 10)
    const firstPage = structured(read(db, { limit: 4 })).messages.map((m) => m.id)
    const secondPage = structured(read(db, { limit: 4, offset: 4 })).messages.map((m) => m.id)

    expect(firstPage).toHaveLength(4)
    expect(secondPage).toHaveLength(4)
    expect(firstPage.filter((id) => secondPage.includes(id))).toEqual([])
  })

  test("an offset past the end returns nothing rather than failing", () => {
    expect(structured(read(seed(0, 3), { offset: 50 })).messages).toEqual([])
  })

  test("reports the page it could not fill instead of implying there is nothing more", () => {
    // Far more rows than the scan ceiling, none of which match.
    const db = seed(6_000, 0)
    const result = read(db, { mailbox: "quiet" })
    expect(structured(result).messages).toEqual([])
    expect(result.content[0]?.type === "text" && result.content[0].text).toContain("Stopped after examining")
  })
})

describe("summarizeMailAccounts", () => {
  const rows = [
    { mailboxUrl: `${NOISY}/INBOX`, unreadCount: 12 },
    { mailboxUrl: `${NOISY}/[Gmail]/All Mail`, unreadCount: 40 },
    { mailboxUrl: `${QUIET}/INBOX`, unreadCount: 0 },
    { mailboxUrl: `${QUIET}/Receipts`, unreadCount: 3 },
  ]
  const config = {
    accounts: { [NOISY.replace("imap://", "")]: { label: "Work", category: "work", provider: "gmail" as const } },
    displayOrder: [],
  }

  test("groups mailboxes under their account and totals the unread", () => {
    const result = summarizeMailAccounts(rows, config, "/tmp/email.json")
    const work = result.accounts.find((account) => account.label === "Work")
    expect(work?.unreadCount).toBe(52)
    expect(work?.mailboxes.map((m) => m.name)).toEqual(["[Gmail]/All Mail", "INBOX"])
  })

  test("an account missing from config is reported as unknown, not hidden", () => {
    const result = summarizeMailAccounts(rows, config, "/tmp/email.json")
    const unconfigured = result.accounts.find((account) => account.label === "unknown")
    expect(unconfigured).toBeDefined()
    expect(unconfigured?.provider).toBe("unknown")
    expect(unconfigured?.mailboxes.map((m) => m.name)).toEqual(["Receipts", "INBOX"])
  })

  test("mailbox names are the decoded path, which is what the mailbox filter matches on", () => {
    const result = summarizeMailAccounts([{ mailboxUrl: `${QUIET}/Sent%20Messages`, unreadCount: 0 }], config, "/x")
    expect(result.accounts[0]?.mailboxes[0]?.name).toBe("Sent Messages")
  })

  test("says where labels come from, and what the values are for", () => {
    const text = describeMailAccounts(summarizeMailAccounts(rows, config, "/tmp/email.json"))
    expect(text).toContain("/tmp/email.json")
    expect(text).toContain('"mailbox"')
    expect(text).toContain("Receipts")
  })

  test("says so plainly when there are no accounts", () => {
    expect(describeMailAccounts(summarizeMailAccounts([], config, "/x"))).toContain("No mail accounts found")
  })
})

// The same rule end to end, through the real query and the real read, on a database shaped like a
// Gmail account sitting next to an ordinary one.
describe("Gmail through runUnreadEmailRead", () => {
  const GMAIL = "imap://9F1C2D3E-0000-4000-8000-000000000001"
  const OTHER = "imap://other%40example.com@imap.example.com"

  const seedGmail = () => {
    const db = new Database(":memory:")
    db.run(`
      CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);
      CREATE TABLE messages (
        ROWID INTEGER PRIMARY KEY, mailbox INTEGER, read INTEGER, deleted INTEGER,
        subject INTEGER, sender INTEGER, message_id INTEGER, date_received INTEGER
      );
      CREATE TABLE labels (message_id INTEGER, mailbox_id INTEGER);
      INSERT INTO mailboxes (ROWID, url) VALUES
        (1, '${GMAIL}/%5BGmail%5D/All%20Mail'),
        (2, '${GMAIL}/INBOX'),
        (3, '${GMAIL}/Newsletters'),
        (4, '${GMAIL}/%5BGmail%5D/Important'),
        (5, '${OTHER}/INBOX');
    `)
    const at = Math.floor(Date.UTC(2026, 9, 1) / 1000)
    const add = db.prepare(
      "INSERT INTO messages (ROWID, mailbox, read, deleted, message_id, date_received) VALUES (?, ?, ?, 0, ?, ?)",
    )
    const label = db.prepare("INSERT INTO labels (message_id, mailbox_id) VALUES (?, ?)")
    add.run(10, 1, 0, 10, at) // unread, in the inbox
    label.run(10, 2)
    add.run(11, 1, 0, 11, at - 1) // unread, filed under a label, not in the inbox
    label.run(11, 3)
    add.run(12, 1, 0, 12, at - 2) // unread, archived: no label at all
    add.run(13, 1, 0, 13, at - 3) // unread, archived but auto-marked Important by Gmail
    label.run(13, 4)
    add.run(14, 1, 1, 14, at - 4) // read, in the inbox: not unread at all
    label.run(14, 2)
    add.run(20, 5, 0, 20, at - 5) // unread in an ordinary account's inbox
    return db
  }

  const mailboxes = (args: Partial<{ mailbox: string }> = {}) =>
    (
      structured(runUnreadEmailRead(seedGmail(), { limit: 25, offset: 0, ...args })).messages as unknown as {
        mailboxName: string
      }[]
    ).map((m) => m.mailboxName)

  test("counts inbox and labelled unread, leaves archived out, and leaves other accounts alone", () => {
    expect(mailboxes().sort()).toEqual(["INBOX", "INBOX", "Newsletters"])
  })

  test("a label filter finds labelled Gmail mail, which used to be reported as INBOX", () => {
    expect(mailboxes({ mailbox: "newsletters" })).toEqual(["Newsletters"])
  })

  test("the inventory counts labelled mail under its label, so Gmail's INBOX no longer reads 0", () => {
    const db = seedGmail()
    const rows = db.query(buildMailboxInventoryQuery(getSchemaInfo(db))).all() as {
      mailboxUrl: string
      unreadCount: number
    }[]
    const unread = Object.fromEntries(
      rows.map((row) => [
        `${row.mailboxUrl.startsWith(GMAIL) ? "gmail" : "other"}:${getMailboxName(row.mailboxUrl)}`,
        row.unreadCount,
      ]),
    )
    expect(unread).toEqual({
      "gmail:[Gmail]/All Mail": 4, // stored there: 10, 11, 12, 13 (14 is read)
      "gmail:INBOX": 1, // 10, by label; Gmail's INBOX holds no rows of its own
      "gmail:Newsletters": 1, // 11, by label
      "gmail:[Gmail]/Important": 1, // 13, by label
      "other:INBOX": 1, // 20, stored directly: non-Gmail counting is unchanged
    })
  })
})
