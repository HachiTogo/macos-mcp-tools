// The memory database: where it lives, its schema, and creating, updating and reading entries.

import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import {
  type CreateEntryArguments,
  chooseOccurrenceTimestamp,
  compareEntriesForRecency,
  type EntryAliasRow,
  type EntryKind,
  type EntryMatcher,
  type EntryRow,
  matchEntry,
  type NormalizedEntry,
  normalizeAliases,
  normalizeEntry,
  normalizeText,
  type QueryMatch,
  type SearchEntriesArguments,
  type UpdateEntryArguments,
} from "./entries"

// ── Constants ──────────────────────────────────────────────────────────

// Data directory: MACOS_TOOLS_DATA_DIR env var, else ~/.local/share/macos-tools/
export function resolveDataDir(): string {
  if (process.env.MACOS_TOOLS_DATA_DIR) {
    const dir = resolve(process.env.MACOS_TOOLS_DATA_DIR)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const defaultDir = join(homedir(), ".local", "share", "macos-tools")
  mkdirSync(defaultDir, { recursive: true })
  return defaultDir
}

export const DEFAULT_LIMIT = 25
export const MAX_LIMIT = 100
export const ENTRY_KINDS = ["memory", "task", "event", "note"] as const satisfies readonly EntryKind[]
export const SOURCE_NAME = "memory"

// ── Database ───────────────────────────────────────────────────────────

export let database: Database | undefined

export const ensureSchema = (db: Database) => {
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

export const getDatabase = () => {
  if (database) {
    return database
  }

  // Resolved here, on first use, rather than at import: resolving creates the directory, and
  // importing this module (as the unit tests do) must not write to the user's home.
  database = new Database(join(resolveDataDir(), "sqlite-memory.db"))
  ensureSchema(database)
  return database
}

export const withTransaction = <T>(callback: (db: Database) => T) => {
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

// ── Database operations ────────────────────────────────────────────────

export const insertAliases = (db: Database, entryId: string, aliases: string[]) => {
  const statement = db.query("INSERT INTO entry_aliases (id, entry_id, alias, normalized_alias) VALUES (?, ?, ?, ?)")

  for (const alias of normalizeAliases(aliases)) {
    statement.run(crypto.randomUUID(), entryId, alias, normalizeText(alias))
  }
}

export const getAliasesByEntryIds = (db: Database, entryIds: string[]) => {
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

export const getEntryById = (db: Database, id: string) => {
  const row = db.query("SELECT * FROM entries WHERE id = ?").get(id) as EntryRow | null

  if (!row) {
    return null
  }

  const aliasesByEntryId = getAliasesByEntryIds(db, [id])
  return normalizeEntry(row, aliasesByEntryId.get(id) ?? [])
}

export const listEntries = (
  db: Database,
  filters: Pick<SearchEntriesArguments, "kind" | "status" | "happened_after" | "happened_before">,
) => {
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

// ── Business logic ─────────────────────────────────────────────────────

export const createEntry = (argumentsValue: CreateEntryArguments) => {
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

export const updateEntry = (argumentsValue: UpdateEntryArguments) => {
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
        throw new Error('Invalid kind: expected one of "memory", "task", "event", "note".')
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

export const selectSearchResults = (entries: NormalizedEntry[], matcher: EntryMatcher, limit: number) => {
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

export const selectBestMatch = (entries: NormalizedEntry[], matcher: EntryMatcher) => {
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
