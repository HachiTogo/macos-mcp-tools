import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildUnreadMessagesQuery, getSchemaInfo } from "./queries"
import { runUnreadEmailRead } from "./read"

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
