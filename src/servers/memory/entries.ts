// Memory entries: their types and the pure logic over them -- normalizing text and aliases, matching
// an entry against a query, choosing its timestamp and ordering by recency. Nothing here touches the
// database.

import { parseLocalDate } from "../../lib/dates"

// ── Types ──────────────────────────────────────────────────────────────

export type EntryKind = "memory" | "task" | "event" | "note"

export type OccurrenceTimestampField = "happened_at" | "start_at" | "created_at"

export type EntryRow = {
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

export type EntryAliasRow = {
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

export type CreateEntryArguments = {
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

export type UpdateEntryArguments = {
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

export type SearchEntriesArguments = EntryMatcher & {
  kind?: EntryKind
  status?: string
  happened_after?: string
  happened_before?: string
  limit: number
}

export type QueryResultArguments = EntryMatcher

export type QueryMatch = {
  entry: NormalizedEntry
  match_reason: Exclude<EntryMatchReason, "none">
  timestamp: string
  timestamp_field: OccurrenceTimestampField
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

// A date-only timestamp ("2026-06-07") counts from local midnight. Read as UTC midnight it started
// the clock hours early: elapsed_hours was off by the UTC offset, and elapsed_days by one each evening.
export const computeDurationSince = (timestamp: string, now = new Date()) => {
  const elapsedMilliseconds = now.getTime() - parseLocalDate(timestamp).getTime()

  return {
    elapsed_days: Math.floor(elapsedMilliseconds / (24 * 60 * 60 * 1000)),
    elapsed_hours: Math.floor(elapsedMilliseconds / (60 * 60 * 1000)),
  } satisfies DurationResult
}

export const buildKeywordSearchText = (
  entry: Pick<NormalizedEntry, "title" | "body" | "subject" | "action" | "object">,
) => normalizeText([entry.title, entry.body, entry.subject, entry.action, entry.object].filter(Boolean).join(" "))

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

  if (
    structuredQueries.length === 0 &&
    normalizedKeywords.length > 0 &&
    exactKeywordMatches === normalizedKeywords.length
  ) {
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

export const normalizeEntry = (row: EntryRow, aliases: string[]) =>
  ({
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

export const compareIsoDescending = (left: string, right: string) => right.localeCompare(left)

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
