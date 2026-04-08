import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { Database } from "bun:sqlite"

// ── Types ──────────────────────────────────────────────────────────────

export type EntryKind = "memory" | "task" | "event" | "note"

type OccurrenceTimestampField = "happened_at" | "start_at" | "created_at"

type EntryRow = {
  id: string
  kind: EntryKind
  title: string | null
  body: string | null
  subject: string | null
  action: string | null
  object: string | null
  status: string | null
  happened_at: string | null
  start_at: string | null
  end_at: string | null
  due_at: string | null
  cost_amount: number | null
  cost_currency: string | null
  source: string | null
  created_at: string
  updated_at: string
}

type EntryAliasRow = {
  entry_id: string
  alias: string
}

export type NormalizedEntry = {
  id: string
  kind: EntryKind
  title: string | null
  body: string | null
  subject: string | null
  action: string | null
  object: string | null
  status: string | null
  happened_at: string | null
  start_at: string | null
  end_at: string | null
  due_at: string | null
  cost_amount: number | null
  cost_currency: string | null
  source: string | null
  created_at: string
  updated_at: string
  aliases: string[]
}

export type EntryMatcher = {
  subject?: string
  action?: string
  object?: string
  keywords?: string[]
}

export type EntryMatchReason = "exact" | "keywords" | "none"

export type EntryMatchResult = {
  matched: boolean
  reason: EntryMatchReason
  exactScore: number
  keywordScore: number
  queryTerms: string[]
}

export type DurationResult = {
  elapsed_days: number
  elapsed_hours: number
}

type CreateEntryArguments = {
  kind: EntryKind
  title?: string | null
  body?: string | null
  subject?: string | null
  action?: string | null
  object?: string | null
  status?: string | null
  happened_at?: string | null
  start_at?: string | null
  end_at?: string | null
  due_at?: string | null
  cost_amount?: number | null
  cost_currency?: string | null
  source?: string | null
  aliases?: string[]
}

type UpdateEntryArguments = {
  id: string
  kind?: EntryKind | null
  title?: string | null
  body?: string | null
  subject?: string | null
  action?: string | null
  object?: string | null
  status?: string | null
  happened_at?: string | null
  start_at?: string | null
  end_at?: string | null
  due_at?: string | null
  cost_amount?: number | null
  cost_currency?: string | null
  source?: string | null
  aliases?: string[]
}

type GetEntryArguments = {
  id: string
}

type SearchEntriesArguments = EntryMatcher & {
  kind?: EntryKind
  status?: string
  happened_after?: string
  happened_before?: string
  limit: number
}

type QueryResultArguments = EntryMatcher

type QueryMatch = {
  entry: NormalizedEntry
  match_reason: Exclude<EntryMatchReason, "none">
  timestamp: string
  timestamp_field: OccurrenceTimestampField
}

// ── Constants ──────────────────────────────────────────────────────────

// Data directory: env var > .opencode/data (if exists) > ~/.local/share/macos-tools/
function resolveDataDir(): string {
  if (process.env.MACOS_TOOLS_DATA_DIR) {
    const dir = resolve(process.env.MACOS_TOOLS_DATA_DIR)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  // Check for .opencode/data relative to cwd (opencode workspace)
  const opencodeDir = resolve(".opencode/data")
  if (existsSync(opencodeDir)) {
    return opencodeDir
  }
  // Default
  const defaultDir = join(homedir(), ".local", "share", "macos-tools")
  mkdirSync(defaultDir, { recursive: true })
  return defaultDir
}

const DATA_DIR = resolveDataDir()
const DB_PATH = join(DATA_DIR, "sqlite-memory.db")
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
const ENTRY_KINDS = ["memory", "task", "event", "note"] as const satisfies readonly EntryKind[]
const SOURCE_NAME = "sqlite-memory"

// ── Database ───────────────────────────────────────────────────────────

let database: Database | undefined

const ensureSchema = (db: Database) => {
  db.query("PRAGMA foreign_keys = ON").run()
  db.query(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('memory', 'task', 'event', 'note')),
      title TEXT,
      body TEXT,
      subject TEXT,
      action TEXT,
      object TEXT,
      status TEXT,
      happened_at TEXT,
      start_at TEXT,
      end_at TEXT,
      due_at TEXT,
      cost_amount REAL,
      cost_currency TEXT,
      source TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run()
  const entryColumns = new Set(
    (db.query("PRAGMA table_info(entries)").all() as Array<{ name: string }>).map((column) => column.name),
  )

  if (!entryColumns.has("cost_amount")) {
    db.query("ALTER TABLE entries ADD COLUMN cost_amount REAL").run()
  }

  if (!entryColumns.has("cost_currency")) {
    db.query("ALTER TABLE entries ADD COLUMN cost_currency TEXT").run()
  }
  db.query(`
    CREATE TABLE IF NOT EXISTS entry_aliases (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
      UNIQUE(entry_id, normalized_alias)
    )
  `).run()
  db.query("CREATE INDEX IF NOT EXISTS idx_entries_kind ON entries(kind)").run()
  db.query("CREATE INDEX IF NOT EXISTS idx_entries_happened_at ON entries(happened_at)").run()
  db.query("CREATE INDEX IF NOT EXISTS idx_entries_start_at ON entries(start_at)").run()
  db.query("CREATE INDEX IF NOT EXISTS idx_entries_due_at ON entries(due_at)").run()
  db.query("CREATE INDEX IF NOT EXISTS idx_entries_subject_action_object ON entries(subject, action, object)").run()
  db.query("CREATE INDEX IF NOT EXISTS idx_entry_aliases_normalized_alias ON entry_aliases(normalized_alias)").run()
}

const getDatabase = () => {
  if (database) {
    return database
  }

  database = new Database(DB_PATH)
  ensureSchema(database)
  return database
}

const withTransaction = <T>(callback: (db: Database) => T) => {
  const db = getDatabase()
  db.query("BEGIN").run()

  try {
    const result = callback(db)
    db.query("COMMIT").run()
    return result
  } catch (error) {
    try {
      db.query("ROLLBACK").run()
    } catch {
      // ignore rollback failure
    }

    throw error
  }
}

// ── Pure helpers ───────────────────────────────────────────────────────

export const normalizeText = (value: string | null | undefined) => {
  if (typeof value !== "string") {
    return ""
  }

  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export const normalizeKeywords = (value: string[] | undefined) => {
  if (!value) {
    return []
  }

  return [...new Set(value.map((entry) => normalizeText(entry)).filter(Boolean))]
}

export const normalizeAliases = (value: string[] | undefined) =>
  [...new Set((value ?? []).map((entry) => entry.trim()).filter(Boolean))].sort((left, right) => {
    const normalizedLeft = normalizeText(left)
    const normalizedRight = normalizeText(right)

    if (normalizedLeft !== normalizedRight) {
      return normalizedLeft.localeCompare(normalizedRight)
    }

    return left.localeCompare(right)
  })

export const chooseOccurrenceTimestamp = (entry: Pick<NormalizedEntry, "happened_at" | "start_at" | "created_at">) => {
  if (entry.happened_at) {
    return {
      timestamp: entry.happened_at,
      field: "happened_at",
    } as const
  }

  if (entry.start_at) {
    return {
      timestamp: entry.start_at,
      field: "start_at",
    } as const
  }

  return {
    timestamp: entry.created_at,
    field: "created_at",
  } as const
}

export const computeDurationSince = (timestamp: string, now = new Date()) => {
  const elapsedMilliseconds = now.getTime() - new Date(timestamp).getTime()

  return {
    elapsed_days: Math.floor(elapsedMilliseconds / (24 * 60 * 60 * 1000)),
    elapsed_hours: Math.floor(elapsedMilliseconds / (60 * 60 * 1000)),
  } satisfies DurationResult
}

export const buildKeywordSearchText = (
  entry: Pick<NormalizedEntry, "title" | "body" | "subject" | "action" | "object">,
) =>
  normalizeText([entry.title, entry.body, entry.subject, entry.action, entry.object].filter(Boolean).join(" "))

export const matchEntry = (
  entry: Pick<NormalizedEntry, "title" | "body" | "subject" | "action" | "object" | "aliases">,
  matcher: EntryMatcher,
) => {
  const normalizedAliases = new Set(normalizeAliases(entry.aliases).map((alias) => normalizeText(alias)))
  const structuredQueries = [
    {
      query: normalizeText(matcher.subject),
      value: normalizeText(entry.subject),
    },
    {
      query: normalizeText(matcher.action),
      value: normalizeText(entry.action),
    },
    {
      query: normalizeText(matcher.object),
      value: normalizeText(entry.object),
    },
  ].filter((item) => item.query)
  const normalizedKeywords = normalizeKeywords(matcher.keywords)
  const exactStructuredMatches = structuredQueries.filter(
    (item) => item.query === item.value || normalizedAliases.has(item.query),
  ).length
  const exactKeywordMatches = normalizedKeywords.filter((keyword) => normalizedAliases.has(keyword)).length

  if (structuredQueries.length > 0 && exactStructuredMatches === structuredQueries.length) {
    return {
      matched: true,
      reason: "exact",
      exactScore: exactStructuredMatches + exactKeywordMatches,
      keywordScore: normalizedKeywords.length,
      queryTerms: [...new Set([...structuredQueries.map((item) => item.query), ...normalizedKeywords])],
    } satisfies EntryMatchResult
  }

  if (structuredQueries.length === 0 && normalizedKeywords.length > 0 && exactKeywordMatches === normalizedKeywords.length) {
    return {
      matched: true,
      reason: "exact",
      exactScore: exactKeywordMatches,
      keywordScore: normalizedKeywords.length,
      queryTerms: normalizedKeywords,
    } satisfies EntryMatchResult
  }

  const queryTerms = [
    ...new Set([...structuredQueries.map((item) => item.query), ...normalizedKeywords].filter(Boolean)),
  ]

  if (queryTerms.length === 0) {
    return {
      matched: true,
      reason: "none",
      exactScore: 0,
      keywordScore: 0,
      queryTerms,
    } satisfies EntryMatchResult
  }

  const searchableText = buildKeywordSearchText(entry)
  const matched = queryTerms.every((term) => searchableText.includes(term))

  return {
    matched,
    reason: matched ? "keywords" : "none",
    exactScore: exactStructuredMatches + exactKeywordMatches,
    keywordScore: matched ? queryTerms.length : 0,
    queryTerms,
  } satisfies EntryMatchResult
}

export const normalizeEntry = (row: EntryRow, aliases: string[]) => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  body: row.body,
  subject: row.subject,
  action: row.action,
  object: row.object,
  status: row.status,
  happened_at: row.happened_at,
  start_at: row.start_at,
  end_at: row.end_at,
  due_at: row.due_at,
  cost_amount: row.cost_amount,
  cost_currency: row.cost_currency,
  source: row.source,
  created_at: row.created_at,
  updated_at: row.updated_at,
  aliases: normalizeAliases(aliases),
}) satisfies NormalizedEntry

const compareIsoDescending = (left: string, right: string) => right.localeCompare(left)

export const compareEntriesForRecency = (
  left: Pick<NormalizedEntry, "id" | "created_at" | "updated_at" | "happened_at" | "start_at">,
  right: Pick<NormalizedEntry, "id" | "created_at" | "updated_at" | "happened_at" | "start_at">,
) => {
  const leftTimestamp = chooseOccurrenceTimestamp(left)
  const rightTimestamp = chooseOccurrenceTimestamp(right)

  if (leftTimestamp.timestamp !== rightTimestamp.timestamp) {
    return compareIsoDescending(leftTimestamp.timestamp, rightTimestamp.timestamp)
  }

  if (left.updated_at !== right.updated_at) {
    return compareIsoDescending(left.updated_at, right.updated_at)
  }

  if (left.created_at !== right.created_at) {
    return compareIsoDescending(left.created_at, right.created_at)
  }

  return left.id.localeCompare(right.id)
}

// ── Database operations ────────────────────────────────────────────────

const insertAliases = (db: Database, entryId: string, aliases: string[]) => {
  const statement = db.query(
    "INSERT INTO entry_aliases (id, entry_id, alias, normalized_alias) VALUES (?, ?, ?, ?)",
  )

  for (const alias of normalizeAliases(aliases)) {
    statement.run(crypto.randomUUID(), entryId, alias, normalizeText(alias))
  }
}

const getAliasesByEntryIds = (db: Database, entryIds: string[]) => {
  const normalizedIds = [...new Set(entryIds.filter(Boolean))]

  if (normalizedIds.length === 0) {
    return new Map<string, string[]>()
  }

  const placeholders = normalizedIds.map(() => "?").join(", ")
  const rows = db
    .query(
      `SELECT entry_id, alias FROM entry_aliases WHERE entry_id IN (${placeholders}) ORDER BY normalized_alias ASC, alias ASC, id ASC`,
    )
    .all(...normalizedIds) as EntryAliasRow[]
  const result = new Map<string, string[]>()

  for (const row of rows) {
    const existing = result.get(row.entry_id)

    if (existing) {
      existing.push(row.alias)
      continue
    }

    result.set(row.entry_id, [row.alias])
  }

  return result
}

const getEntryById = (db: Database, id: string) => {
  const row = db.query("SELECT * FROM entries WHERE id = ?").get(id) as EntryRow | null

  if (!row) {
    return null
  }

  const aliasesByEntryId = getAliasesByEntryIds(db, [id])
  return normalizeEntry(row, aliasesByEntryId.get(id) ?? [])
}

const listEntries = (db: Database, filters: Pick<SearchEntriesArguments, "kind" | "status" | "happened_after" | "happened_before">) => {
  const whereClauses: string[] = []
  const values: string[] = []

  if (filters.kind) {
    whereClauses.push("kind = ?")
    values.push(filters.kind)
  }

  if (filters.status) {
    whereClauses.push("status = ?")
    values.push(filters.status)
  }

  if (filters.happened_after) {
    whereClauses.push("happened_at >= ?")
    values.push(filters.happened_after)
  }

  if (filters.happened_before) {
    whereClauses.push("happened_at <= ?")
    values.push(filters.happened_before)
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : ""
  const rows = db
    .query(`SELECT * FROM entries ${whereSql} ORDER BY created_at DESC, id ASC`)
    .all(...values) as EntryRow[]
  const aliasesByEntryId = getAliasesByEntryIds(
    db,
    rows.map((row) => row.id),
  )

  return rows.map((row) => normalizeEntry(row, aliasesByEntryId.get(row.id) ?? []))
}

const formatToolResult = (payload: Record<string, unknown>) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(payload, null, 2),
    },
  ],
  structuredContent: payload,
})

// ── Business logic ─────────────────────────────────────────────────────

const createEntry = (argumentsValue: CreateEntryArguments) => {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()

  return withTransaction((db) => {
    db.query(
      `
        INSERT INTO entries (
          id, kind, title, body, subject, action, object, status,
          happened_at, start_at, end_at, due_at, cost_amount, cost_currency, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      id,
      argumentsValue.kind,
      argumentsValue.title ?? null,
      argumentsValue.body ?? null,
      argumentsValue.subject ?? null,
      argumentsValue.action ?? null,
      argumentsValue.object ?? null,
      argumentsValue.status ?? null,
      argumentsValue.happened_at ?? null,
      argumentsValue.start_at ?? null,
      argumentsValue.end_at ?? null,
      argumentsValue.due_at ?? null,
      argumentsValue.cost_amount ?? null,
      argumentsValue.cost_currency ?? null,
      argumentsValue.source ?? null,
      now,
      now,
    )

    insertAliases(db, id, argumentsValue.aliases ?? [])

    const entry = getEntryById(db, id)

    if (!entry) {
      throw new Error(`Entry not found after create: ${id}`)
    }

    return entry
  })
}

const updateEntry = (argumentsValue: UpdateEntryArguments) => {
  return withTransaction((db) => {
    const existing = getEntryById(db, argumentsValue.id)

    if (!existing) {
      return null
    }

    const updates: string[] = []
    const values: Array<string | number | null> = []

    const addUpdate = (field: string, value: string | number | null | EntryKind) => {
      updates.push(`${field} = ?`)
      values.push(value)
    }

    if (argumentsValue.kind !== undefined) {
      if (argumentsValue.kind === null) {
        throw new Error("Invalid kind: expected one of \"memory\", \"task\", \"event\", \"note\".")
      }

      addUpdate("kind", argumentsValue.kind)
    }

    if (argumentsValue.title !== undefined) addUpdate("title", argumentsValue.title)
    if (argumentsValue.body !== undefined) addUpdate("body", argumentsValue.body)
    if (argumentsValue.subject !== undefined) addUpdate("subject", argumentsValue.subject)
    if (argumentsValue.action !== undefined) addUpdate("action", argumentsValue.action)
    if (argumentsValue.object !== undefined) addUpdate("object", argumentsValue.object)
    if (argumentsValue.status !== undefined) addUpdate("status", argumentsValue.status)
    if (argumentsValue.happened_at !== undefined) addUpdate("happened_at", argumentsValue.happened_at)
    if (argumentsValue.start_at !== undefined) addUpdate("start_at", argumentsValue.start_at)
    if (argumentsValue.end_at !== undefined) addUpdate("end_at", argumentsValue.end_at)
    if (argumentsValue.due_at !== undefined) addUpdate("due_at", argumentsValue.due_at)
    if (argumentsValue.cost_amount !== undefined) addUpdate("cost_amount", argumentsValue.cost_amount)
    if (argumentsValue.cost_currency !== undefined) addUpdate("cost_currency", argumentsValue.cost_currency)
    if (argumentsValue.source !== undefined) addUpdate("source", argumentsValue.source)

    if (updates.length > 0) {
      updates.push("updated_at = ?")
      values.push(new Date().toISOString())
      values.push(argumentsValue.id)
      db.query(`UPDATE entries SET ${updates.join(", ")} WHERE id = ?`).run(...values)
    }

    if (argumentsValue.aliases !== undefined) {
      db.query("DELETE FROM entry_aliases WHERE entry_id = ?").run(argumentsValue.id)
      insertAliases(db, argumentsValue.id, argumentsValue.aliases)
    }

    return getEntryById(db, argumentsValue.id)
  })
}

const selectSearchResults = (entries: NormalizedEntry[], matcher: EntryMatcher, limit: number) => {
  const hasTerms = Boolean(matcher.subject || matcher.action || matcher.object || matcher.keywords?.length)

  return entries
    .map((entry) => ({
      entry,
      match: matchEntry(entry, matcher),
    }))
    .filter((item) => (hasTerms ? item.match.matched : true))
    .sort((left, right) => {
      const leftReasonRank = left.match.reason === "exact" ? 2 : left.match.reason === "keywords" ? 1 : 0
      const rightReasonRank = right.match.reason === "exact" ? 2 : right.match.reason === "keywords" ? 1 : 0

      if (leftReasonRank !== rightReasonRank) {
        return rightReasonRank - leftReasonRank
      }

      if (left.match.exactScore !== right.match.exactScore) {
        return right.match.exactScore - left.match.exactScore
      }

      if (left.match.keywordScore !== right.match.keywordScore) {
        return right.match.keywordScore - left.match.keywordScore
      }

      return compareEntriesForRecency(left.entry, right.entry)
    })
    .slice(0, limit)
    .map((item) => item.entry)
}

const selectBestMatch = (entries: NormalizedEntry[], matcher: EntryMatcher) => {
  const matches = entries
    .map((entry) => ({
      entry,
      match: matchEntry(entry, matcher),
    }))
    .filter((item) => item.match.matched && item.match.reason !== "none")

  const exactMatches = matches.filter((item) => item.match.reason === "exact")
  const pool = exactMatches.length > 0 ? exactMatches : matches.filter((item) => item.match.reason === "keywords")

  if (pool.length === 0) {
    return null
  }

  pool.sort((left, right) => {
    if (left.match.exactScore !== right.match.exactScore) {
      return right.match.exactScore - left.match.exactScore
    }

    if (left.match.keywordScore !== right.match.keywordScore) {
      return right.match.keywordScore - left.match.keywordScore
    }

    return compareEntriesForRecency(left.entry, right.entry)
  })

  const best = pool[0]
  if (!best) {
    return null
  }
  const occurrence = chooseOccurrenceTimestamp(best.entry)

  return {
    entry: best.entry,
    match_reason: best.match.reason as Exclude<typeof best.match.reason, "none">,
    timestamp: occurrence.timestamp,
    timestamp_field: occurrence.field,
  } satisfies QueryMatch
}

// ── MCP Server ─────────────────────────────────────────────────────────

const server = new McpServer({ name: "sqlite-memory", version: "0.0.1" })

const nullableString = z.union([z.string(), z.null()]).optional()
const nullableNumber = z.union([z.number(), z.null()]).optional()

server.registerTool(
  "create_entry",
  {
    description: "Create a memory, task, event, or note entry with optional aliases.",
    inputSchema: {
      kind: z.enum(ENTRY_KINDS).describe("Entry kind"),
      title: nullableString,
      subject: nullableString,
      action: nullableString,
      object: nullableString,
      body: nullableString,
      source: nullableString,
      status: nullableString,
      happened_at: nullableString,
      start_at: nullableString,
      end_at: nullableString,
      due_at: nullableString,
      cost_amount: nullableNumber,
      cost_currency: nullableString,
      aliases: z.array(z.string()).optional(),
    },
  },
  async (args) => {
    try {
      const entry = createEntry(args as CreateEntryArguments)
      return formatToolResult({ source: SOURCE_NAME, entry })
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }
    }
  },
)

server.registerTool(
  "update_entry",
  {
    description: "Update an existing entry. Only specified fields are changed.",
    inputSchema: {
      id: z.string().describe("Entry ID"),
      kind: z.union([z.enum(ENTRY_KINDS), z.null()]).optional(),
      title: nullableString,
      subject: nullableString,
      action: nullableString,
      object: nullableString,
      body: nullableString,
      source: nullableString,
      status: nullableString,
      happened_at: nullableString,
      start_at: nullableString,
      end_at: nullableString,
      due_at: nullableString,
      cost_amount: nullableNumber,
      cost_currency: nullableString,
      aliases: z.array(z.string()).optional(),
    },
  },
  async (args) => {
    try {
      const entry = updateEntry(args as UpdateEntryArguments)

      if (!entry) {
        return {
          content: [{ type: "text" as const, text: `Entry not found: ${args.id}` }],
          structuredContent: { source: SOURCE_NAME, entry: null },
          isError: true,
        }
      }

      return formatToolResult({ source: SOURCE_NAME, entry })
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }
    }
  },
)

server.registerTool(
  "get_entry",
  {
    description: "Fetch a single normalized entry with aliases by ID.",
    inputSchema: {
      id: z.string().describe("Entry ID"),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    try {
      const entry = getEntryById(getDatabase(), args.id)

      if (!entry) {
        return {
          content: [{ type: "text" as const, text: `Entry not found: ${args.id}` }],
          structuredContent: { source: SOURCE_NAME, entry: null },
          isError: true,
        }
      }

      return formatToolResult({ source: SOURCE_NAME, entry })
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }
    }
  },
)

server.registerTool(
  "search_entries",
  {
    description: "Search entries with deterministic structured filters and keyword fallback.",
    inputSchema: {
      kind: z.enum(ENTRY_KINDS).optional(),
      subject: z.string().optional(),
      action: z.string().optional(),
      object: z.string().optional(),
      status: z.string().optional(),
      happened_after: z.string().optional(),
      happened_before: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    try {
      const limit = args.limit ?? DEFAULT_LIMIT
      const searchArgs: SearchEntriesArguments = { ...args, limit }
      const entries = listEntries(getDatabase(), searchArgs)
      const results = selectSearchResults(entries, searchArgs, limit)
      return formatToolResult({ source: SOURCE_NAME, query: searchArgs, entries: results })
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }
    }
  },
)

server.registerTool(
  "query_last_occurrence",
  {
    description: "Return the most recent matching entry using happened_at, start_at, then created_at.",
    inputSchema: {
      subject: z.string().optional(),
      action: z.string().optional(),
      object: z.string().optional(),
      keywords: z.array(z.string()).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    try {
      const entries = listEntries(getDatabase(), {})
      const match = selectBestMatch(entries, args as QueryResultArguments)

      if (!match) {
        return formatToolResult({ source: SOURCE_NAME, query: args, status: "no_match" })
      }

      return formatToolResult({ source: SOURCE_NAME, query: args, status: "matched", ...match })
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }
    }
  },
)

server.registerTool(
  "query_duration_since",
  {
    description: "Return the most recent matching entry plus elapsed days and hours.",
    inputSchema: {
      subject: z.string().optional(),
      action: z.string().optional(),
      object: z.string().optional(),
      keywords: z.array(z.string()).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    try {
      const entries = listEntries(getDatabase(), {})
      const match = selectBestMatch(entries, args as QueryResultArguments)

      if (!match) {
        return formatToolResult({ source: SOURCE_NAME, query: args, status: "no_match" })
      }

      return formatToolResult({
        source: SOURCE_NAME,
        query: args,
        status: "matched",
        ...match,
        ...computeDurationSince(match.timestamp),
      })
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }
    }
  },
)

// ── Entry point ────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
