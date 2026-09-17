#!/usr/bin/env bun

// Single source of truth for subcommands: usage text, validation, and dispatch all derive from this map.
const SERVERS = {
  mail: { summary: "Apple Mail (read, search, mark read/junk, attachments)", load: () => import("./servers/mail.js") },
  contacts: { summary: "Apple Contacts (people and groups CRUD)", load: () => import("./servers/contacts.js") },
  notes: { summary: "Apple Notes (folders, notes CRUD, search)", load: () => import("./servers/notes.js") },
  memory: { summary: "Memory store (structured entries with search and duration queries)", load: () => import("./servers/memory.js") },
  messages: { summary: "Apple Messages (iMessage/SMS read, search, send)", load: () => import("./servers/messages.js") },
  events: { summary: "Apple Calendar (events and calendars CRUD)", load: () => import("./servers/events.js") },
  reminders: { summary: "Apple Reminders (tasks, lists, subtasks CRUD)", load: () => import("./servers/reminders.js") },
} as const

// tsc requires an export for top-level await; dynamic imports alone do not make this file a module.
export {}

type Subcommand = keyof typeof SERVERS

const SUBCOMMANDS = Object.keys(SERVERS) as Subcommand[]
const PAD = Math.max(...SUBCOMMANDS.map((name) => name.length))

const USAGE = `
macos-mcp-tools — MCP servers for macOS

Usage:
  macos-mcp-tools <subcommand>

Subcommands:
${SUBCOMMANDS.map((name) => `  ${name.padEnd(PAD)}  ${SERVERS[name].summary}`).join("\n")}

Examples:
  bunx @hachitogo/macos-mcp-tools mail

Each subcommand starts a standalone MCP server on stdio.
`.trim()

const isSubcommand = (value: string | undefined): value is Subcommand =>
  value !== undefined && Object.hasOwn(SERVERS, value)

const subcommand = process.argv[2]

if (!subcommand || subcommand === "--help" || subcommand === "-h") {
  console.log(USAGE)
  process.exit(0)
}

if (!isSubcommand(subcommand)) {
  console.error(`Unknown subcommand: ${subcommand}\n`)
  console.error(USAGE)
  process.exit(1)
}

// Dynamic import so only the requested server is loaded
await SERVERS[subcommand].load()
