import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  escapeLikePattern,
  extractTextFromBody,
  formatChatList,
  getMessages,
  getParticipants,
  isoToAppleNanos,
  listChats,
  resolveText,
  searchMessages,
} from "./messages"

// Build a minimal attributedBody-style blob: opaque header, "NSString", "+", length prefix, UTF-8 text.
const buildBody = (text: string, lengthForm: "short" | "u16" = "short"): Uint8Array => {
  const encoded = new TextEncoder().encode(text)
  const header = new Uint8Array([0x04, 0x0b, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d, 0x74, 0x79, 0x70, 0x65, 0x64, 0x00])
  const marker = new TextEncoder().encode("NSString")
  const plus = new Uint8Array([0x01, 0x94, 0x84, 0x01, 0x2b])
  const length =
    lengthForm === "short"
      ? new Uint8Array([encoded.length])
      : new Uint8Array([0x81, encoded.length & 0xff, encoded.length >> 8])
  return new Uint8Array([...header, ...marker, ...plus, ...length, ...encoded, 0x86])
}

describe("attributedBody decoding", () => {
  test("extracts short-form text", () => {
    expect(extractTextFromBody(buildBody("See you at the dentist"))).toBe("See you at the dentist")
  })

  test("extracts 16-bit length form text", () => {
    const long = "x".repeat(300)
    expect(extractTextFromBody(buildBody(long, "u16"))).toBe(long)
  })

  test("returns null for empty or unrecognised blobs", () => {
    expect(extractTextFromBody(null)).toBeNull()
    expect(extractTextFromBody(new Uint8Array())).toBeNull()
    expect(extractTextFromBody(new TextEncoder().encode("no marker here"))).toBeNull()
  })
})

describe("resolveText", () => {
  test("prefers the text column and falls back to attributedBody", () => {
    expect(resolveText({ text: "plain", attributedBody: buildBody("rich") })).toBe("plain")
    expect(resolveText({ text: null, attributedBody: buildBody("rich") })).toBe("rich")
    expect(resolveText({ text: null, attributedBody: null })).toBeNull()
  })
})

describe("escapeLikePattern", () => {
  test("escapes LIKE metacharacters and the escape character itself", () => {
    expect(escapeLikePattern("50%")).toBe("50\\%")
    expect(escapeLikePattern("a_b")).toBe("a\\_b")
    expect(escapeLikePattern("back\\slash")).toBe("back\\\\slash")
    expect(escapeLikePattern("plain")).toBe("plain")
  })
})

describe("isoToAppleNanos", () => {
  const DEFAULT_TZ = process.env.TZ

  afterEach(() => {
    if (DEFAULT_TZ) {
      process.env.TZ = DEFAULT_TZ
    } else {
      delete process.env.TZ
    }
  })

  // Messages stores nanoseconds since 2001-01-01 UTC. In Pacific time a bare date read as UTC put
  // the bound at 17:00 the day before, so a one-day range was mostly the previous evening.
  test("a bare date bound is local midnight", () => {
    process.env.TZ = "America/Los_Angeles"
    const appleEpochMs = Date.UTC(2001, 0, 1)
    const localMidnight = new Date(2026, 9, 1).getTime()
    expect(isoToAppleNanos("2026-10-01")).toBe(((localMidnight - appleEpochMs) / 1000) * 1e9)
  })

  test("a timestamp with a zone is honoured exactly", () => {
    process.env.TZ = "America/Los_Angeles"
    const appleEpochMs = Date.UTC(2001, 0, 1)
    expect(isoToAppleNanos("2026-10-01T00:00:00Z")).toBe(((Date.UTC(2026, 9, 1) - appleEpochMs) / 1000) * 1e9)
  })
})

// A minimal chat.db: only the tables and columns the queries read. Two chats with messages (one 1:1,
// one group), one chat with none, a message whose text lives only in attributedBody, and a reaction.
const appleNanos = (iso: string) => ((Date.parse(iso) - Date.UTC(2001, 0, 1)) / 1000) * 1e9

const fixture = () => {
  const db = new Database(":memory:")
  db.run(
    `CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT, service_name TEXT, style INTEGER)`,
  )
  db.run(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT)`)
  db.run(`CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER)`)
  db.run(`CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER)`)
  db.run(
    `CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER, handle_id INTEGER, is_read INTEGER, associated_message_type INTEGER)`,
  )
  db.run(`INSERT INTO handle VALUES (1, '+15555550101', 'iMessage'), (2, '+15555550102', 'iMessage')`)
  db.run(
    `INSERT INTO chat VALUES (1, '+15555550101', '', 'iMessage', 45), (2, 'chat100', 'Book club', 'iMessage', 43), (3, '+15555550199', '', 'SMS', 45)`,
  )
  db.run(`INSERT INTO chat_handle_join VALUES (1, 1), (2, 1), (2, 2)`)
  const insert = db.query(`INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const messages: [number, number, string | null, Uint8Array | null, number, string, number, number, number][] = [
    [1, 1, "See you at 6", null, 0, "2026-10-01T15:00:00Z", 1, 1, 0],
    [2, 1, "Loved \u201cSee you at 6\u201d", null, 1, "2026-10-01T15:30:00Z", 0, 1, 2000],
    [3, 1, null, buildBody("Running 10% late"), 1, "2026-10-01T16:00:00Z", 0, 1, 0],
    [4, 2, "Next book?", null, 0, "2026-10-02T09:00:00Z", 2, 1, 0],
    [5, 2, "Dune", null, 0, "2026-10-02T09:05:00Z", 1, 0, 0],
  ]
  for (const [id, chat, text, body, fromMe, at, handle, read, associated] of messages) {
    insert.run(id, `guid-${id}`, text, body, fromMe, appleNanos(at), handle, read, associated)
    db.run(`INSERT INTO chat_message_join VALUES (?, ?)`, [chat, id])
  }
  return db
}

describe("chat.db queries", () => {
  const DEFAULT_TZ = process.env.TZ
  let db: Database

  beforeEach(() => {
    process.env.TZ = "America/Los_Angeles"
    db = fixture()
  })

  afterEach(() => {
    db.close()
    if (DEFAULT_TZ) {
      process.env.TZ = DEFAULT_TZ
    } else {
      delete process.env.TZ
    }
  })

  test("list_chats orders by latest message, skips empty chats, and previews rich-text bodies", () => {
    const chats = listChats({ limit: 10, offset: 0 }, db)
    expect(chats.map((c) => c.chatId)).toEqual(["chat100", "+15555550101"])
    expect(chats[0]).toMatchObject({
      displayName: "Book club",
      isGroup: true,
      participantCount: 2,
      lastMessage: "Dune",
    })
    expect(chats[1]).toMatchObject({ displayName: "+15555550101", isGroup: false, lastMessage: "Running 10% late" })
  })

  test("get_messages is chronological, decodes attributedBody, marks my messages, and leaves out reactions", () => {
    const messages = getMessages("+15555550101", { limit: 50, offset: 0 }, db)
    expect(messages.map((m) => [m.text, m.sender])).toEqual([
      ["See you at 6", "+15555550101"],
      ["Running 10% late", "me"],
    ])
    expect(getMessages("+15555550101", { limit: 1, offset: 0 }, db).map((m) => m.text)).toEqual(["Running 10% late"])
  })

  test("get_messages date bounds: a bare date is local midnight, a timestamp is exact", () => {
    // 2026-10-01T08:30-07:00 is 15:30Z: the first message (15:00Z) is inside, the later one is not.
    const morning = getMessages(
      "+15555550101",
      { limit: 50, offset: 0, fromDate: "2026-10-01", toDate: "2026-10-01T08:30:00-07:00" },
      db,
    )
    expect(morning.map((m) => m.text)).toEqual(["See you at 6"])
    // Local Oct 2 starts at 07:00Z, so both 09:00Z group messages are on it.
    expect(getMessages("chat100", { limit: 50, offset: 0, fromDate: "2026-10-02" }, db)).toHaveLength(2)
  })

  test("search_messages matches text and attributedBody case-insensitively, literally, within a chat", () => {
    expect(searchMessages("LATE", { limit: 50, offset: 0 }, db).map((m) => m.text)).toEqual(["Running 10% late"])
    expect(searchMessages("10%", { limit: 50, offset: 0 }, db)).toHaveLength(1)
    expect(searchMessages("0_", { limit: 50, offset: 0 }, db)).toEqual([])
    const inGroup = searchMessages("e", { limit: 50, offset: 0, chatIdentifier: "chat100" }, db)
    expect(inGroup.map((m) => [m.text, m.chatId])).toEqual([
      ["Dune", "chat100"],
      ["Next book?", "chat100"],
    ])
    expect(searchMessages("e", { limit: 1, offset: 0 }, db)).toHaveLength(1)
  })

  test("list_chats text shows each chat's chat_id, which a named group's name does not reveal", () => {
    const text = formatChatList(listChats({ limit: 10, offset: 0 }, db))
    expect(text).toContain("1. Book club (group, 2 participants; chat_id: chat100): Dune")
    expect(text).toContain("2. +15555550101 (1:1; chat_id: +15555550101): Running 10% late")
  })

  test("list_chats pages by offset", () => {
    expect(listChats({ limit: 1, offset: 1 }, db).map((c) => c.chatId)).toEqual(["+15555550101"])
    expect(listChats({ limit: 1, offset: 2 }, db)).toEqual([])
  })

  test("get_messages offset skips the newest messages and keeps each page chronological", () => {
    // chat100 holds "Next book?" then "Dune"; offset 1 skips the newest, leaving the older one.
    expect(getMessages("chat100", { limit: 1, offset: 1 }, db).map((m) => m.text)).toEqual(["Next book?"])
    const page = (offset: number) => getMessages("+15555550101", { limit: 1, offset }, db).map((m) => m.text)
    expect([...page(1), ...page(0)]).toEqual(
      getMessages("+15555550101", { limit: 2, offset: 0 }, db).map((m) => m.text),
    )
  })

  test("search_messages offset counts matches, not rows, so a non-matching rich-text body is not skipped", () => {
    const all = searchMessages("e", { limit: 50, offset: 0 }, db).map((m) => m.id)
    expect(searchMessages("e", { limit: 1, offset: 1 }, db).map((m) => m.id)).toEqual([all[1]])
    // For "you", SQL returns the newer rich-text row (which does not match) and then the one match. Counting
    // rows, offset 1 would skip the rich-text row and return the match; counting matches skips the match.
    expect(searchMessages("you", { limit: 50, offset: 0 }, db).map((m) => m.text)).toEqual(["See you at 6"])
    expect(searchMessages("you", { limit: 50, offset: 1 }, db)).toEqual([])
  })

  test("get_participants lists a chat's handles", () => {
    expect(getParticipants("chat100", db)).toEqual([
      { handle: "+15555550101", service: "iMessage" },
      { handle: "+15555550102", service: "iMessage" },
    ])
  })
})
