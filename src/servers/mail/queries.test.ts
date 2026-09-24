import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"

import { EmailToolError } from "./errors"
import { buildSearchMessagesQuery, buildUnreadMessagesQuery, ensureRequiredColumns, getSchemaInfo } from "./queries"
import type { SchemaInfo, SearchEmailArguments } from "./types"

// The builders assemble SQL from whichever columns the Envelope Index happens to have, so testing
// the strings they produce proves very little. These tests run the SQL against an in-memory
// database shaped like a real Envelope Index: a query that is malformed, joins wrongly or filters
// wrongly fails here rather than on a user's Mac.

const FULL_SCHEMA = `
  CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);
  CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
  CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT, comment TEXT);
  CREATE TABLE senders (ROWID INTEGER PRIMARY KEY, contact_identifier TEXT);
  CREATE TABLE sender_addresses (sender INTEGER, address INTEGER);
  CREATE TABLE message_global_data (message_id INTEGER, message_id_header TEXT);
  CREATE TABLE messages (
    ROWID INTEGER PRIMARY KEY,
    mailbox INTEGER,
    read INTEGER,
    deleted INTEGER,
    subject INTEGER,
    sender INTEGER,
    message_id INTEGER,
    date_received INTEGER,
    display_date INTEGER,
    document_id TEXT,
    subject_prefix TEXT
  );
`

/** 2026-09-01T00:00:00Z and 2026-09-20T00:00:00Z, the two dates the date-filter tests straddle. */
const EARLY = Math.floor(Date.UTC(2026, 8, 1) / 1000)
const LATE = Math.floor(Date.UTC(2026, 8, 20) / 1000)

const seed = (schema: string = FULL_SCHEMA) => {
  const db = new Database(":memory:")
  db.run(schema)

  if (schema === FULL_SCHEMA) {
    db.run(`
      INSERT INTO mailboxes (ROWID, url) VALUES
        (1, 'imap://work%40example.com@imap.example.com/INBOX'),
        (2, 'local://Drafts'),
        (3, 'imap://work%40example.com@imap.example.com/Archive');
      INSERT INTO subjects (ROWID, subject) VALUES (10, 'Quarterly invoice'), (11, 'Lunch plans');
      INSERT INTO addresses (ROWID, address, comment) VALUES
        (20, 'billing@vendor.example', 'Vendor Billing'),
        (21, 'friend@example.com', 'A Friend');
      INSERT INTO senders (ROWID, contact_identifier) VALUES (30, 'vendor-contact');
      INSERT INTO sender_addresses (sender, address) VALUES (30, 20);
      INSERT INTO message_global_data (message_id, message_id_header) VALUES (40, '<abc@vendor.example>');
      INSERT INTO messages
        (ROWID, mailbox, read, deleted, subject, sender, message_id, date_received, document_id, subject_prefix)
      VALUES
        (100, 1, 0, 0, 10, 20, 40, ${LATE}, 'doc-100', 'Re: '),
        (101, 1, 1, 0, 11, 21, 41, ${LATE}, 'doc-101', NULL),
        (102, 1, 0, 1, 10, 20, 42, ${LATE}, 'doc-102', NULL),
        (103, 2, 0, 0, 11, 21, 43, ${LATE}, 'doc-103', NULL),
        (104, 3, 0, 0, 11, 21, 44, ${EARLY}, 'doc-104', NULL);
    `)
  }
  return db
}

type Row = { rowIdText: string; resolvedSubject: string | null; resolvedSenderAddress: string | null }

describe("getSchemaInfo and ensureRequiredColumns", () => {
  test("reads the column sets the builders branch on", () => {
    const schema = getSchemaInfo(seed())
    expect(schema.messages.has("date_received")).toBe(true)
    expect(schema.mailboxes.has("url")).toBe(true)
    expect(schema.subjects.has("subject")).toBe(true)
    expect(schema.messages.has("nonexistent")).toBe(false)
  })

  test("reports a missing table as empty rather than throwing", () => {
    const db = new Database(":memory:")
    db.run("CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, mailbox INTEGER, read INTEGER, deleted INTEGER);")
    const schema = getSchemaInfo(db)
    expect(schema.subjects.size).toBe(0)
    expect(schema.messages.has("mailbox")).toBe(true)
  })

  test("names the column that is missing", () => {
    const schema = getSchemaInfo(seed())
    expect(() => ensureRequiredColumns(schema)).not.toThrow()

    const withoutRead: SchemaInfo = { ...schema, messages: new Set(["mailbox", "deleted"]) }
    expect(() => ensureRequiredColumns(withoutRead)).toThrow(EmailToolError)
    expect(() => ensureRequiredColumns(withoutRead)).toThrow(/messages\.read/)

    const withoutMailboxUrl: SchemaInfo = { ...schema, mailboxes: new Set<string>() }
    expect(() => ensureRequiredColumns(withoutMailboxUrl)).toThrow(/mailboxes\.url/)
  })
})

describe("buildUnreadMessagesQuery", () => {
  test("returns only undeleted, unread, non-local messages", () => {
    const db = seed()
    const rows = db.query(buildUnreadMessagesQuery(getSchemaInfo(db))).all() as Row[]
    // 100 and 104 qualify. 101 is read, 102 is deleted, 103 is in a local:// mailbox.
    expect(rows.map((row) => row.rowIdText).sort()).toEqual(["100", "104"])
  })

  test("resolves the subject and sender through their lookup tables", () => {
    const db = seed()
    const rows = db.query(buildUnreadMessagesQuery(getSchemaInfo(db))).all() as Row[]
    const invoice = rows.find((row) => row.rowIdText === "100")
    expect(invoice?.resolvedSubject).toBe("Quarterly invoice")
    expect(invoice?.resolvedSenderAddress).toBe("billing@vendor.example")
  })

  test("orders newest first", () => {
    const db = seed()
    const rows = db.query(buildUnreadMessagesQuery(getSchemaInfo(db))).all() as Row[]
    expect(rows[0]?.rowIdText).toBe("100")
  })

  test("still produces runnable SQL when the lookup tables are absent", () => {
    const db = new Database(":memory:")
    db.run(`
      CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);
      CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, mailbox INTEGER, read INTEGER, deleted INTEGER);
      INSERT INTO mailboxes (ROWID, url) VALUES (1, 'imap://a@b/INBOX');
      INSERT INTO messages (ROWID, mailbox, read, deleted) VALUES (1, 1, 0, 0);
    `)
    const rows = db.query(buildUnreadMessagesQuery(getSchemaInfo(db))).all() as Row[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.resolvedSubject).toBeNull()
  })
})

describe("buildSearchMessagesQuery", () => {
  // `limit` is required on SearchEmailArguments but the builder caps rows at READ_FETCH_LIMIT and
  // ignores it, so the tests supply one and vary only the filters.
  const search = (filters: Partial<SearchEmailArguments> = {}): SearchEmailArguments => ({ limit: 25, ...filters })

  const run = (filters: Partial<SearchEmailArguments> = {}) => {
    const db = seed()
    const { sql, params } = buildSearchMessagesQuery(getSchemaInfo(db), search(filters))
    return { rows: db.query(sql).all(...params) as Row[], params }
  }

  test("returns read messages too unless unreadOnly is set", () => {
    expect(
      run({})
        .rows.map((row) => row.rowIdText)
        .sort(),
    ).toEqual(["100", "101", "104"])
    expect(
      run({ unreadOnly: true })
        .rows.map((row) => row.rowIdText)
        .sort(),
    ).toEqual(["100", "104"])
  })

  test("matches a subject substring and binds it as a parameter", () => {
    const { rows, params } = run({ subject: "invoice" })
    expect(rows.map((row) => row.rowIdText)).toEqual(["100"])
    expect(params).toContain("%invoice%")
  })

  test("matches on sender address and on sender display name", () => {
    expect(run({ sender: "billing@vendor" }).rows.map((row) => row.rowIdText)).toEqual(["100"])
    // 101 and 104 both carry sender 21, so a display-name match returns both.
    expect(
      run({ sender: "A Friend" })
        .rows.map((row) => row.rowIdText)
        .sort(),
    ).toEqual(["101", "104"])
  })

  test("a message just after local midnight is inside that day's `after` bound", () => {
    // The bug this pins: a bare date parsed as UTC midnight put the boundary at 17:00 the previous
    // day in Pacific time, so 00:30 local landed outside the range it obviously belongs to.
    const db = seed()
    const justAfterMidnight = Math.floor(new Date(2026, 8, 15, 0, 30).getTime() / 1000)
    db.run(`INSERT INTO messages (ROWID, mailbox, read, deleted, subject, sender, message_id, date_received)
            VALUES (200, 1, 0, 0, 10, 20, 50, ${justAfterMidnight})`)

    const { sql, params } = buildSearchMessagesQuery(getSchemaInfo(db), search({ after: "2026-09-15" }))
    const rows = db.query(sql).all(...params) as Row[]
    expect(rows.map((row) => row.rowIdText)).toContain("200")

    const next = buildSearchMessagesQuery(getSchemaInfo(db), search({ after: "2026-09-16" }))
    expect((db.query(next.sql).all(...next.params) as Row[]).map((row) => row.rowIdText)).not.toContain("200")
  })

  test("filters by received date, inclusive of after and exclusive of before", () => {
    expect(
      run({ after: "2026-09-19" })
        .rows.map((row) => row.rowIdText)
        .sort(),
    ).toEqual(["100", "101"])
    expect(run({ before: "2026-09-19" }).rows.map((row) => row.rowIdText)).toEqual(["104"])
  })

  test("never returns messages from local:// mailboxes", () => {
    expect(run({}).rows.map((row) => row.rowIdText)).not.toContain("103")
  })

  test("binds one parameter per LIKE placeholder", () => {
    const { sql, params } = buildSearchMessagesQuery(getSchemaInfo(seed()), search({ subject: "x", sender: "y" }))
    expect(params).toHaveLength((sql.match(/\?/g) ?? []).length)
  })
})
