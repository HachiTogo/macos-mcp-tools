import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

import { isoTimestampString } from "../lib/dates"
import { jsonResult, runTool, textResult } from "../lib/mcp-result"
import { PACKAGE_VERSION } from "../lib/version"
import {
  type CreateEntryArguments,
  computeDurationSince,
  type QueryResultArguments,
  type SearchEntriesArguments,
  type UpdateEntryArguments,
} from "./memory/entries"
import {
  createEntry,
  DEFAULT_LIMIT,
  ENTRY_KINDS,
  getDatabase,
  getEntryById,
  listEntries,
  MAX_LIMIT,
  SOURCE_NAME,
  selectBestMatch,
  selectSearchResults,
  updateEntry,
} from "./memory/store"

// ── MCP Server ─────────────────────────────────────────────────────────

const server = new McpServer({ name: "memory", version: PACKAGE_VERSION })

const nullableString = z.union([z.string(), z.null()]).optional()

// Timestamps are stored and compared as text, so they must be ISO 8601. Saying so in the schema lets
// the agent convert "yesterday" before it calls; a value that slips through is refused, not stored.
const TIMESTAMP_FORMAT =
  "ISO 8601 date or timestamp, e.g. '2026-10-08' or '2026-10-08T14:30:00-07:00'. Convert relative dates such as 'yesterday' to a date first."
const timestamp = (field: string, meaning: string) =>
  isoTimestampString(field).nullable().optional().describe(`${meaning} ${TIMESTAMP_FORMAT}`)
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
      happened_at: timestamp("happened_at", "When it happened."),
      start_at: timestamp("start_at", "When it starts."),
      end_at: timestamp("end_at", "When it ends."),
      due_at: timestamp("due_at", "When it is due."),
      cost_amount: nullableNumber,
      cost_currency: nullableString,
      aliases: z.array(z.string()).optional(),
    },
  },
  async (args) =>
    runTool("create_entry", () => {
      const entry = createEntry(args as CreateEntryArguments)
      return jsonResult({ source: SOURCE_NAME, entry })
    }),
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
      happened_at: timestamp("happened_at", "When it happened."),
      start_at: timestamp("start_at", "When it starts."),
      end_at: timestamp("end_at", "When it ends."),
      due_at: timestamp("due_at", "When it is due."),
      cost_amount: nullableNumber,
      cost_currency: nullableString,
      aliases: z.array(z.string()).optional(),
    },
  },
  async (args) =>
    runTool("update_entry", () => {
      const entry = updateEntry(args as UpdateEntryArguments)

      if (!entry) {
        return {
          ...textResult(`Entry not found: ${args.id}`, { source: SOURCE_NAME, entry: null }),
          isError: true,
        }
      }

      return jsonResult({ source: SOURCE_NAME, entry })
    }),
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
  async (args) =>
    runTool("get_entry", () => {
      const entry = getEntryById(getDatabase(), args.id)

      if (!entry) {
        return {
          ...textResult(`Entry not found: ${args.id}`, { source: SOURCE_NAME, entry: null }),
          isError: true,
        }
      }

      return jsonResult({ source: SOURCE_NAME, entry })
    }),
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
      happened_after: isoTimestampString("happened_after")
        .optional()
        .describe(`Only entries that happened on or after this. ${TIMESTAMP_FORMAT}`),
      happened_before: isoTimestampString("happened_before")
        .optional()
        .describe(`Only entries that happened on or before this. ${TIMESTAMP_FORMAT}`),
      keywords: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    runTool("search_entries", () => {
      const limit = args.limit ?? DEFAULT_LIMIT
      const searchArgs: SearchEntriesArguments = { ...args, limit }
      const entries = listEntries(getDatabase(), searchArgs)
      const results = selectSearchResults(entries, searchArgs, limit)
      return jsonResult({ source: SOURCE_NAME, query: searchArgs, entries: results })
    }),
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
  async (args) =>
    runTool("query_last_occurrence", () => {
      const entries = listEntries(getDatabase(), {})
      const match = selectBestMatch(entries, args as QueryResultArguments)

      if (!match) {
        return jsonResult({ source: SOURCE_NAME, query: args, status: "no_match" })
      }

      return jsonResult({ source: SOURCE_NAME, query: args, status: "matched", ...match })
    }),
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
  async (args) =>
    runTool("query_duration_since", () => {
      const entries = listEntries(getDatabase(), {})
      const match = selectBestMatch(entries, args as QueryResultArguments)

      if (!match) {
        return jsonResult({ source: SOURCE_NAME, query: args, status: "no_match" })
      }

      return jsonResult({
        source: SOURCE_NAME,
        query: args,
        status: "matched",
        ...match,
        ...computeDurationSince(match.timestamp),
      })
    }),
)

// ── Entry point ────────────────────────────────────────────────────────

export const main = async () => {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// Boot only when executed directly; cli.ts and tests import this module without starting a server.
if (import.meta.main) {
  await main()
}
