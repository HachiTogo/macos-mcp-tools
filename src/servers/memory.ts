import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { CREATE, DESTRUCTIVE, READ } from "../lib/annotations"
import { isoTimestampString } from "../lib/dates"
import { jsonResult, runTool, textResult } from "../lib/mcp-result"
import { offsetArg } from "../lib/paging"
import { serve } from "../lib/serve"
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
const TIMESTAMP_FORMAT = "ISO 8601; convert relative dates like 'yesterday' first"
const timestamp = (field: string) => isoTimestampString(field).nullable().optional().describe(TIMESTAMP_FORMAT)
const nullableNumber = z.union([z.number(), z.null()]).optional()

// The structuredContent each read tool declares. Objects are loose, so a field present only
// sometimes, or added later, never fails a call that worked; nested items detail only what agents
// pass back.
const entry = z.looseObject({ id: z.string() })
export const entryOutput = z.looseObject({ source: z.string(), entry: entry.nullable() })
export const entriesOutput = z.looseObject({ source: z.string(), query: z.looseObject({}), entries: z.array(entry) })
/** query_last_occurrence and query_duration_since: matched, with the entry, or no_match. */
export const occurrenceOutput = z.looseObject({
  source: z.string(),
  query: z.looseObject({}),
  status: z.enum(["matched", "no_match"]),
  entry: entry.optional(),
})

server.registerTool(
  "create_entry",
  {
    description: "Create a memory, task, event or note entry, with optional aliases.",
    inputSchema: {
      kind: z.enum(ENTRY_KINDS),
      title: nullableString,
      subject: nullableString,
      action: nullableString,
      object: nullableString,
      body: nullableString,
      source: nullableString,
      status: nullableString,
      happened_at: timestamp("happened_at"),
      start_at: timestamp("start_at"),
      end_at: timestamp("end_at"),
      due_at: timestamp("due_at"),
      cost_amount: nullableNumber,
      cost_currency: nullableString,
      aliases: z.array(z.string()).optional(),
    },
    annotations: CREATE,
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
    description: "Update an entry; only the fields given change.",
    inputSchema: {
      id: z.string(),
      kind: z.union([z.enum(ENTRY_KINDS), z.null()]).optional(),
      title: nullableString,
      subject: nullableString,
      action: nullableString,
      object: nullableString,
      body: nullableString,
      source: nullableString,
      status: nullableString,
      happened_at: timestamp("happened_at"),
      start_at: timestamp("start_at"),
      end_at: timestamp("end_at"),
      due_at: timestamp("due_at"),
      cost_amount: nullableNumber,
      cost_currency: nullableString,
      aliases: z.array(z.string()).optional(),
    },
    annotations: DESTRUCTIVE,
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
    description: "One entry, with its aliases.",
    inputSchema: {
      id: z.string(),
    },
    outputSchema: entryOutput,
    annotations: READ,
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
    description: "Search entries by structured fields, falling back to keywords.",
    inputSchema: {
      kind: z.enum(ENTRY_KINDS).optional(),
      subject: z.string().optional(),
      action: z.string().optional(),
      object: z.string().optional(),
      status: z.string().optional(),
      happened_after: isoTimestampString("happened_after").optional().describe(`Inclusive. ${TIMESTAMP_FORMAT}`),
      happened_before: isoTimestampString("happened_before").optional().describe(`Inclusive. ${TIMESTAMP_FORMAT}`),
      keywords: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).optional(),
      offset: offsetArg,
    },
    outputSchema: entriesOutput,
    annotations: READ,
  },
  async (args) =>
    runTool("search_entries", () => {
      const limit = args.limit ?? DEFAULT_LIMIT
      const searchArgs: SearchEntriesArguments = { ...args, limit }
      const entries = listEntries(getDatabase(), searchArgs)
      const results = selectSearchResults(entries, searchArgs, limit, args.offset)
      return jsonResult({ source: SOURCE_NAME, query: searchArgs, entries: results })
    }),
)

server.registerTool(
  "query_last_occurrence",
  {
    description: "The latest matching entry, by happened_at, then start_at, then created_at.",
    inputSchema: {
      subject: z.string().optional(),
      action: z.string().optional(),
      object: z.string().optional(),
      keywords: z.array(z.string()).optional(),
    },
    outputSchema: occurrenceOutput,
    annotations: READ,
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
    description: "The latest matching entry and the days and hours since it.",
    inputSchema: {
      subject: z.string().optional(),
      action: z.string().optional(),
      object: z.string().optional(),
      keywords: z.array(z.string()).optional(),
    },
    outputSchema: occurrenceOutput,
    annotations: READ,
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

export const main = () => serve(server)

// Boot only when executed directly; cli.ts and tests import this module without starting a server.
if (import.meta.main) {
  await main()
}
