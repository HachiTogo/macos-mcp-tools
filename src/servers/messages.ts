// Apple Messages MCP server — hybrid SQLite reads + JXA sends.
// Inspired by @griches/apple-messages-mcp (MIT): https://github.com/griches/apple-mcp
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { PACKAGE_VERSION } from "../lib/version"
import { z } from "zod"
import { runJxa } from "../lib/jxa.js"

// ── Constants ─────────────────────────────────────────────────────────

const CHAT_DB_PATH = join(homedir(), "Library/Messages/chat.db")
const SOURCE_NAME = "Apple Messages"
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const APPLE_EPOCH_OFFSET = 978307200
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "local"

// ── Types ─────────────────────────────────────────────────────────────

type ChatRow = {
  chatId: number
  chatIdentifier: string
  displayName: string | null
  serviceName: string | null
  style: number
  lastMessageText: string | null
  lastMessageBody: Uint8Array | null
  lastMessageDate: number | null
  participantCount: number
}

type MessageRow = {
  rowid: number
  guid: string
  text: string | null
  attributedBody: Uint8Array | null
  isFromMe: number
  date: number
  senderId: string | null
  isRead: number
  associatedType: number
}

type ParticipantRow = {
  handleId: string
  service: string
}

type NormalizedChat = {
  chatId: string
  displayName: string
  isGroup: boolean
  service: string
  lastMessage: string | null
  lastMessageAt: string | null
  participantCount: number
  source: string
}

type NormalizedMessage = {
  id: number
  text: string | null
  isFromMe: boolean
  sender: string | null
  date: string
  dateLocal: string
  isRead: boolean
  source: string
}

type NormalizedParticipant = {
  handle: string
  service: string
}

type SendResult = {
  status: "sent" | "error"
  to: string
  detail?: string
}

// ── Date helpers ──────────────────────────────────────────────────────

const appleNanosToUnix = (nanos: number): number =>
  Math.floor(nanos / 1e9) + APPLE_EPOCH_OFFSET

const appleNanosToIso = (nanos: number): string =>
  new Date(appleNanosToUnix(nanos) * 1000).toISOString()

const appleNanosToLocal = (nanos: number): string =>
  new Date(appleNanosToUnix(nanos) * 1000).toLocaleString("en-US", { timeZone: TIME_ZONE })

const isoToAppleNanos = (iso: string): number => {
  const unix = Math.floor(new Date(iso).getTime() / 1000)
  return (unix - APPLE_EPOCH_OFFSET) * 1e9
}

// ── attributedBody extraction ─────────────────────────────────────────

const NS_STRING_MARKER = new TextEncoder().encode("NSString")

export const extractTextFromBody = (blob: Uint8Array | null): string | null => {
  if (!blob || blob.length === 0) return null
  const buf = Buffer.from(blob)
  const idx = buf.indexOf(NS_STRING_MARKER)
  if (idx < 0) return null
  const rest = buf.subarray(idx + NS_STRING_MARKER.length)
  const plusIdx = rest.indexOf(0x2b) // '+'
  if (plusIdx < 0) return null
  const after = rest.subarray(plusIdx + 1)
  if (after.length === 0) return null

  let textLen: number
  let textStart: number
  const flag = after[0]
  if (flag < 0x80) {
    textLen = flag
    textStart = 1
  } else if (flag === 0x81) {
    if (after.length < 3) return null
    textLen = after[1] | (after[2] << 8)
    textStart = 3
  } else if (flag === 0x82) {
    if (after.length < 5) return null
    textLen = after[1] | (after[2] << 8) | (after[3] << 16) | (after[4] << 24)
    textStart = 5
  } else {
    return null
  }

  if (after.length < textStart + textLen) return null
  return after.subarray(textStart, textStart + textLen).toString("utf-8")
}

export const resolveText = (row: { text: string | null, attributedBody: Uint8Array | null }): string | null =>
  row.text || extractTextFromBody(row.attributedBody) || null

// Escape LIKE metacharacters so a query like "50%" matches literally. Pair with ESCAPE '\\' in SQL.
export const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, "\\$&")

// ── Database helpers ──────────────────────────────────────────────────

const openDb = (): Database => new Database(CHAT_DB_PATH, { readonly: true })

const withDb = <T>(fn: (db: Database) => T): T => {
  const db = openDb()
  try {
    return fn(db)
  } finally {
    db.close(false)
  }
}

// ── Query functions ───────────────────────────────────────────────────

const listChats = (limit: number): NormalizedChat[] =>
  withDb((db) => {
    const rows = db.query(`
      SELECT
        c.ROWID           AS chatId,
        c.chat_identifier AS chatIdentifier,
        c.display_name    AS displayName,
        c.service_name    AS serviceName,
        c.style           AS style,
        (SELECT m.text FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         WHERE cmj.chat_id = c.ROWID
         ORDER BY m.date DESC LIMIT 1)  AS lastMessageText,
        (SELECT m.attributedBody FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         WHERE cmj.chat_id = c.ROWID
         ORDER BY m.date DESC LIMIT 1)  AS lastMessageBody,
        (SELECT MAX(m.date) FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         WHERE cmj.chat_id = c.ROWID)   AS lastMessageDate,
        (SELECT COUNT(*) FROM chat_handle_join chj
         WHERE chj.chat_id = c.ROWID)   AS participantCount
      FROM chat c
      WHERE EXISTS (
        SELECT 1 FROM chat_message_join cmj WHERE cmj.chat_id = c.ROWID
      )
      ORDER BY lastMessageDate DESC
      LIMIT ?
    `).all(limit) as ChatRow[]

    return rows.map((row) => {
      const lastText = resolveText({ text: row.lastMessageText, attributedBody: row.lastMessageBody })
      return {
      chatId: row.chatIdentifier,
      displayName: row.displayName || row.chatIdentifier,
      isGroup: row.style === 43,
      service: row.serviceName || "iMessage",
      lastMessage: lastText
        ? lastText.length > 100
          ? lastText.slice(0, 100) + "…"
          : lastText
        : null,
      lastMessageAt: row.lastMessageDate ? appleNanosToIso(row.lastMessageDate) : null,
      participantCount: row.participantCount,
      source: SOURCE_NAME,
    }})
  })

const getMessages = (
  chatIdentifier: string,
  limit: number,
  fromDate?: string,
  toDate?: string,
): NormalizedMessage[] =>
  withDb((db) => {
    const conditions = [
      "c.chat_identifier = ?",
      "m.associated_message_type = 0",
    ]
    const params: (string | number)[] = [chatIdentifier]

    if (fromDate) {
      conditions.push("m.date >= ?")
      params.push(isoToAppleNanos(fromDate))
    }
    if (toDate) {
      conditions.push("m.date <= ?")
      params.push(isoToAppleNanos(toDate))
    }

    params.push(limit)

    const rows = db.query(`
      SELECT
        m.ROWID                   AS rowid,
        m.guid                    AS guid,
        m.text                    AS text,
        m.attributedBody          AS attributedBody,
        m.is_from_me              AS isFromMe,
        m.date                    AS date,
        h.id                      AS senderId,
        m.is_read                 AS isRead,
        m.associated_message_type AS associatedType
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE ${conditions.join(" AND ")}
      ORDER BY m.date DESC
      LIMIT ?
    `).all(...params) as MessageRow[]

    return rows.reverse().map((row) => ({
      id: row.rowid,
      text: resolveText(row),
      isFromMe: row.isFromMe === 1,
      sender: row.isFromMe === 1 ? "me" : (row.senderId || "unknown"),
      date: appleNanosToIso(row.date),
      dateLocal: appleNanosToLocal(row.date),
      isRead: row.isRead === 1,
      source: SOURCE_NAME,
    }))
  })

export const searchMessages = (
  query: string,
  limit: number,
  chatIdentifier?: string,
): (NormalizedMessage & { chatId: string })[] =>
  withDb((db) => {
    // Modern Messages rows often have text = NULL with the body only in attributedBody, so the SQL
    // LIKE alone misses them. Rows with NULL text are decoded in JS via resolveText, exactly as
    // get_messages renders them, and matched case-insensitively there.
    const conditions = [
      "(m.text LIKE ? ESCAPE '\\' OR (m.text IS NULL AND m.attributedBody IS NOT NULL))",
      "m.associated_message_type = 0",
    ]
    const params: (string | number)[] = [`%${escapeLikePattern(query)}%`]

    if (chatIdentifier) {
      conditions.push("c.chat_identifier = ?")
      params.push(chatIdentifier)
    }

    const statement = db.query(`
      SELECT
        m.ROWID            AS rowid,
        m.guid             AS guid,
        m.text             AS text,
        m.attributedBody   AS attributedBody,
        m.is_from_me       AS isFromMe,
        m.date             AS date,
        h.id               AS senderId,
        m.is_read          AS isRead,
        m.associated_message_type AS associatedType,
        c.chat_identifier  AS chatIdentifier
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE ${conditions.join(" AND ")}
      ORDER BY m.date DESC
    `)

    const needle = query.toLowerCase()
    const results: (NormalizedMessage & { chatId: string })[] = []
    for (const row of statement.iterate(...params) as IterableIterator<MessageRow & { chatIdentifier: string }>) {
      const text = resolveText(row)
      if (!text || !text.toLowerCase().includes(needle)) continue
      results.push({
        id: row.rowid,
        text,
        isFromMe: row.isFromMe === 1,
        sender: row.isFromMe === 1 ? "me" : (row.senderId || "unknown"),
        date: appleNanosToIso(row.date),
        dateLocal: appleNanosToLocal(row.date),
        isRead: row.isRead === 1,
        chatId: row.chatIdentifier,
        source: SOURCE_NAME,
      })
      if (results.length >= limit) break
    }
    return results
  })

const getParticipants = (chatIdentifier: string): NormalizedParticipant[] =>
  withDb((db) => {
    const rows = db.query(`
      SELECT h.id AS handleId, h.service AS service
      FROM handle h
      JOIN chat_handle_join chj ON chj.handle_id = h.ROWID
      JOIN chat c ON c.ROWID = chj.chat_id
      WHERE c.chat_identifier = ?
    `).all(chatIdentifier) as ParticipantRow[]

    return rows.map((row) => ({
      handle: row.handleId,
      service: row.service,
    }))
  })

// ── JXA send ──────────────────────────────────────────────────────────

const JXA_SEND_MESSAGE = String.raw`
function run(argv) {
  var args = JSON.parse(argv[0] || "{}")
  var Messages = Application("Messages")
  var text = args.text || ""
  var target = args.to || ""

  if (!text) return JSON.stringify({ status: "error", to: target, detail: "Message text is required." })
  if (!target) return JSON.stringify({ status: "error", to: target, detail: "Recipient is required." })

  // Find the chat whose internal ID ends with the target identifier.
  // 1:1 chats: "any;-;ennea.kyle@icloud.com"  group chats: "any;+;chat64037..."
  var suffix = ";" + target
  var chats = Messages.chats()
  for (var i = 0; i < chats.length; i++) {
    try {
      if (chats[i].id().endsWith(suffix)) {
        Messages.send(text, { to: chats[i] })
        return JSON.stringify({ status: "sent", to: target })
      }
    } catch (e) { continue }
  }
  return JSON.stringify({ status: "error", to: target, detail: "Chat not found for: " + target })
}
`

const sendMessage = (to: string, text: string): SendResult => {
  const raw = runJxa(JXA_SEND_MESSAGE, { to, text })
  return JSON.parse(raw) as SendResult
}

// ── Formatting helpers ────────────────────────────────────────────────

const formatChatList = (chats: NormalizedChat[]): string => {
  if (chats.length === 0) return "No recent conversations found."
  const lines = chats.map((c, i) => {
    const type = c.isGroup ? `group, ${c.participantCount} participants` : "1:1"
    const preview = c.lastMessage ? `: ${c.lastMessage}` : ""
    return `${i + 1}. ${c.displayName} (${type})${preview}`
  })
  return `Found ${chats.length} conversation(s):\n\n${lines.join("\n")}`
}

const formatMessages = (messages: NormalizedMessage[], chatId: string): string => {
  if (messages.length === 0) return `No messages found in ${chatId}.`
  const lines = messages.map((m) => {
    const body = m.text || "(attachment or unsupported content)"
    return `[${m.dateLocal}] ${m.sender}: ${body}`
  })
  return `${messages.length} message(s) from ${chatId}:\n\n${lines.join("\n")}`
}

const formatSearchResults = (results: (NormalizedMessage & { chatId: string })[], query: string): string => {
  if (results.length === 0) return `No messages matching "${query}".`
  const lines = results.map((m) => {
    const body = m.text || "(attachment or unsupported content)"
    return `[${m.dateLocal}] [${m.chatId}] ${m.sender}: ${body}`
  })
  return `Found ${results.length} message(s) matching "${query}":\n\n${lines.join("\n")}`
}

const formatParticipants = (participants: NormalizedParticipant[], chatId: string): string => {
  if (participants.length === 0) return `No participants found for ${chatId}.`
  const lines = participants.map((p) => `- ${p.handle} (${p.service})`)
  return `${participants.length} participant(s) in ${chatId}:\n\n${lines.join("\n")}`
}

const formatSendResult = (result: SendResult): string =>
  result.status === "sent"
    ? `Message sent to ${result.to}.`
    : `Send failed: ${result.detail || "unknown error"}`

// ── MCP Server ────────────────────────────────────────────────────────

const server = new McpServer({ name: "apple-messages", version: PACKAGE_VERSION })

server.registerTool(
  "list_chats",
  {
    description: "List recent iMessage/SMS conversations with last message preview and participant count.",
    inputSchema: {
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).optional()
        .describe("Maximum conversations to return (1–200). Default: 50."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ limit }) => {
    try {
      const chats = listChats(limit ?? DEFAULT_LIMIT)
      return {
        content: [{ type: "text" as const, text: formatChatList(chats) }],
        structuredContent: { source: SOURCE_NAME, chats },
      }
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Failed to list chats: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      }
    }
  },
)

server.registerTool(
  "get_messages",
  {
    description: "Get message history for a specific conversation. Use chat_identifier values from list_chats (phone number, email, or group chat ID like 'chat123456').",
    inputSchema: {
      chat_id: z.string()
        .describe("Chat identifier: phone number (e.g. '+13109236683'), email, or group ID (e.g. 'chat465552106698701545')."),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).optional()
        .describe("Maximum messages to return (1–200). Default: 50."),
      from_date: z.string().optional()
        .describe("ISO 8601 date. Only return messages on or after this date. Example: '2026-01-15' or '2026-01-15T09:00:00Z'."),
      to_date: z.string().optional()
        .describe("ISO 8601 date. Only return messages before this date."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ chat_id, limit, from_date, to_date }) => {
    try {
      const messages = getMessages(chat_id, limit ?? DEFAULT_LIMIT, from_date, to_date)
      return {
        content: [{ type: "text" as const, text: formatMessages(messages, chat_id) }],
        structuredContent: { source: SOURCE_NAME, chatId: chat_id, messages },
      }
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Failed to get messages: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      }
    }
  },
)

server.registerTool(
  "search_messages",
  {
    description: "Search messages by text content across all conversations, or within a specific conversation. Matches case-insensitively, including rich-text message bodies.",
    inputSchema: {
      query: z.string().min(1)
        .describe("Text to search for in message content."),
      chat_id: z.string().optional()
        .describe("Limit search to a specific chat identifier."),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).optional()
        .describe("Maximum results to return (1–200). Default: 50."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, chat_id, limit }) => {
    try {
      const results = searchMessages(query, limit ?? DEFAULT_LIMIT, chat_id)
      return {
        content: [{ type: "text" as const, text: formatSearchResults(results, query) }],
        structuredContent: { source: SOURCE_NAME, query, results },
      }
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Failed to search messages: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      }
    }
  },
)

server.registerTool(
  "get_participants",
  {
    description: "Get participants of a conversation. Useful for identifying group chat members.",
    inputSchema: {
      chat_id: z.string()
        .describe("Chat identifier from list_chats."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ chat_id }) => {
    try {
      const participants = getParticipants(chat_id)
      return {
        content: [{ type: "text" as const, text: formatParticipants(participants, chat_id) }],
        structuredContent: { source: SOURCE_NAME, chatId: chat_id, participants },
      }
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Failed to get participants: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      }
    }
  },
)

server.registerTool(
  "send_message",
  {
    description: "Send an iMessage to a phone number, email address, or group chat. For group chats, use the chat identifier (e.g. 'chat465552106698701545') from list_chats.",
    inputSchema: {
      to: z.string()
        .describe("Recipient: phone number (e.g. '+13109236683'), email, or group chat identifier (e.g. 'chat465552106698701545')."),
      text: z.string().min(1)
        .describe("Message text to send."),
    },
  },
  async ({ to, text }) => {
    try {
      const result = sendMessage(to, text)
      return {
        content: [{ type: "text" as const, text: formatSendResult(result) }],
        structuredContent: result,
        ...(result.status === "error" ? { isError: true } : {}),
      }
    } catch (error) {
      const result: SendResult = { status: "error", to, detail: error instanceof Error ? error.message : String(error) }
      return {
        content: [{ type: "text" as const, text: formatSendResult(result) }],
        structuredContent: result,
        isError: true,
      }
    }
  },
)

// ── Entry point ───────────────────────────────────────────────────────

export const main = async () => {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// Boot only when executed directly; cli.ts and tests import this module without starting a server.
if (import.meta.main) {
  await main()
}
