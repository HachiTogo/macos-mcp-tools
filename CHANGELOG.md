# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-09-18

### Changed
- **All servers**: one response contract, defined in `src/lib/mcp-result.ts`. Human-readable text stays as before; every successful response now also carries its payload in `structuredContent` (contacts and notes gained this); every failure is an `isError` result whose text reads `<tool> failed: <message>`. Previously notes and contacts returned the bare error message, messages used `Failed to <verb>: ...`, and events/reminders used `Failed to <operation>: ...`. Agents matching on error text should update.
- **Events / Reminders**: validation errors are also prefixed with the operation name.
- Code style is now enforced by Biome (`bun run lint`, `bun run format`); the whole repo was formatted to the documented no-semicolon, double-quote style. CI fails on lint or format drift.

### Added
- `src/lib/mcp-result.ts` helpers (`textResult`, `jsonResult`, `errorResult`, `runTool`, `errorMessage`) with unit tests.
- `@biomejs/biome` 2.5.14 as a pinned dev dependency, configured in `biome.jsonc`.

## [0.3.1] - 2026-09-18

### Fixed
- **Mail**: top-level `Junk`, `Spam`, `Trash`, `Drafts`, `Outbox` and `Deleted Messages` mailboxes are now excluded from `unread_emails`; previously only nested paths such as `[Gmail]/Spam` were.
- **Mail**: account groups sort deterministically when `displayOrder` is empty (the comparator returned `NaN` for every auto-discovered config).
- **Mail**: `mark_emails_read`, `mark_emails_junk`, `mark_emails_not_junk` and `flag_emails` set `isError` when every item failed (`not_found`, `invalid_handle`, ...). Partial success still reports per-item statuses.
- **Messages**: `search_messages` now finds messages whose body is stored only in `attributedBody` (the common case on current macOS); it uses the same decoder as `get_messages`. `%`, `_` and `\` in the query are matched literally.
- **Events**: `calendar_events` with `action: "read"` and an `id` returned "not found" for every event because the unbounded query was clipped by EventKit's four-year predicate limit. It now searches two years either side of today.
- **Events / Reminders**: tool errors report their underlying message instead of `System error occurred`.
- **CLI**: usage text names the real binary, `macos-mcp-tools`.

### Changed
- Every MCP server reports the package version from `package.json` instead of a hardcoded `0.0.1`/`0.1.0`.
- Servers export `main()` and start only when run directly, so importing them from tests no longer boots a stdio server.
- Toolchain pinned for reproducible CI: `@types/bun` `^1.3.14`, Bun `1.3.14` in workflows, `actions/checkout@v5`. Redundant zod `overrides`/`resolutions` and unused tsconfig build options removed.
- `AGENTS.md` now requires one SemVer version bump per merged PR or PR stack.

### Added
- `LICENSE` file (MIT), matching the license already declared in `package.json`.
- Unit tests for `messages.ts` (first coverage) and for the mail and EventKit helpers changed above.

## [0.3.0] - 2026-05-27

### Removed
- **BREAKING**: The `tasks` server and its tools (`list_tasks`, `get_task`, `create_task`, `update_task`, `complete_task`, `drop_task`, `reopen_task`, `list_projects`) were removed. Use the `reminders` server for task management. Existing `tasks.db` files are left untouched.

_No 0.2.0 was tagged; 0.3.0 followed 0.1.0 directly._

## [0.1.0] - 2026-05-27

### Added
- **Events Server**: Apple Calendar via EventKit (`calendar_events`, `calendar_calendars`) with recurrence, alarms, structured locations and availability.
- **Reminders Server**: Apple Reminders via EventKit (`reminders_tasks`, `reminders_lists`, `reminders_subtasks`) with subtasks, tags, priorities, location triggers and recurrence.
- Swift helper `EventKitCLI` (`swift/EventKitCLI.swift`, built with `bun run build:swift`) and a prebuilt `bin/EventKitCLI` for Apple Silicon.

## [0.0.6] - 2026-05-27

### Fixed
- Synced `package.json` version with the release tag.

## [0.0.5] - 2026-05-27

### Changed
- README lists the `flag_emails` mail tool.

## [0.0.4] - 2026-05-27

### Changed
- **BREAKING**: Renamed MCP server identifiers and `source` payload fields:
  - `memory` server: `sqlite-memory` → `memory`
  - `tasks` server: `task-manager` → `tasks`
  Consumers reading the `source` field on tool results must update their expectations. Database filenames (`sqlite-memory.db`, `tasks.db`) are unchanged.
- **BREAKING**: Removed the `.opencode/data` tier-2 fallback in `resolveDataDir()`. Data directory resolution is now: `MACOS_TOOLS_DATA_DIR` env var, else `~/.local/share/macos-tools/`.

### Added
- **Messages Server**: New Apple Messages MCP server with 5 tools for iMessage and SMS.
  Hybrid architecture: SQLite reads from `~/Library/Messages/chat.db` for fast queries, JXA/AppleScript for sending.
  Supports both 1:1 and group chat sending.
  Inspired by [@griches/apple-messages-mcp](https://github.com/griches/apple-mcp) (MIT).
  - `list_chats` — list recent conversations with last message preview and participant count
  - `get_messages` — get message history for a specific chat with date range filtering
  - `search_messages` — search messages by text content across all or specific conversations
  - `get_participants` — get participants of a conversation
  - `send_message` — send iMessage to a phone number, email, or group chat
- **Mail Server**: `extract_email_links` tool — extracts every hyperlink from an Apple Mail message as `{ url, text }` pairs by parsing the raw RFC 822 source server-side. The HTML source is never returned to the caller; only the link pairs are returned.
- **Mail Server**: `flag_emails` tool — set flag color (`flagIndex`), flagged status, or background color on Apple Mail messages via JXA. Supports batch operations with per-message flag/color settings.
- Pure-helper unit tests for the `tasks` server (`applyFlaggedToTags`).

## [0.0.3] - 2026-04-08

### Fixed
- Corrected the npm `bin` entry so the published package retains its CLI launcher

## [0.0.2] - 2026-04-08

### Changed
- Added npm publishing metadata: `publishConfig`, `repository`, `homepage`, and `bugs`
- Prepared a clean follow-up release so the npm package matches tagged source

## [0.0.1] - 2026-04-08

### Added
- Initial release of `@hachitogo/macos-mcp-tools`
- **Mail Server**: Apple Mail MCP server with read/search/mutate capabilities
  - `unread_emails`, `mark_emails_read`, `fetch_email_body`, `mark_emails_junk`
  - `mark_emails_not_junk`, `list_email_attachments`, `fetch_email_attachment`, `search_emails`
- **Contacts Server**: Apple Contacts CRUD via JXA
  - `contacts_people`, `contacts_groups`
- **Notes Server**: Apple Notes full CRUD with search
  - `list_folders`, `create_folder`, `list_notes`, `get_note`, `create_note`
  - `update_note`, `move_note`, `append_to_note`, `delete_note`, `delete_folder`, `search_notes`
- **Tasks Server**: SQLite-backed task manager with projects, tags, and flags
  - `list_tasks`, `get_task`, `create_task`, `update_task`, `complete_task`
  - `drop_task`, `reopen_task`, `list_projects`
- **Memory Server**: Structured memory store with SAO triples
  - `create_entry`, `update_entry`, `get_entry`, `search_entries`
  - `query_last_occurrence`, `query_duration_since`
- Configuration via `MACOS_TOOLS_DATA_DIR` environment variable
- Support for Claude Desktop, Cursor, and opencode MCP configurations

### Known Issues
- Read-only smoke tests exist for Mail, Contacts, and Notes, but broader mutation coverage still requires manual verification
