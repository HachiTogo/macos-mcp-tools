#!/usr/bin/env bun

const SUBCOMMANDS = ["mail", "contacts", "notes", "tasks", "memory"] as const
type Subcommand = (typeof SUBCOMMANDS)[number]

const USAGE = `
macos-tools — MCP servers for macOS

Usage:
  macos-tools <subcommand>

Subcommands:
  mail       Apple Mail (read, search, mark read/junk, attachments)
  contacts   Apple Contacts (people and groups CRUD)
  notes      Apple Notes (folders, notes CRUD, search)
  tasks      Task manager (SQLite-backed tasks with repeat rules)
  memory     Memory store (structured entries with search and duration queries)

Examples:
  bunx @hachitogo/macos-mcp-tools mail
  bunx @hachitogo/macos-mcp-tools tasks

Each subcommand starts a standalone MCP server on stdio.
`.trim()

const subcommand = process.argv[2]

if (!subcommand || subcommand === "--help" || subcommand === "-h") {
  console.log(USAGE)
  process.exit(0)
}

if (!SUBCOMMANDS.includes(subcommand as Subcommand)) {
  console.error(`Unknown subcommand: ${subcommand}\n`)
  console.error(USAGE)
  process.exit(1)
}

export {}

// Dynamic import to only load the requested server
switch (subcommand) {
  case "mail":
    await import("./servers/mail.js")
    break
  case "contacts":
    await import("./servers/contacts.js")
    break
  case "notes":
    await import("./servers/notes.js")
    break
  case "tasks":
    await import("./servers/tasks.js")
    break
  case "memory":
    await import("./servers/memory.js")
    break
}
