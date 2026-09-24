# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **A hand-edited mail account config is no longer destroyed by a typo.** `email.json` was read through a catch-all that turned *any* failure — including a JSON syntax error — into an empty config. The caller read that as "not configured yet" and overwrote the file with rediscovered defaults, losing every label. A file that does not parse is now reported, naming the path and the problem, and is never written over.
- **The config moved to the data directory** (`MACOS_TOOLS_DATA_DIR`, else `~/.local/share/macos-tools/`), alongside the memory database. It previously resolved inside the install directory, which a global upgrade replaces and which `bunx` may not be able to write at all. An existing file is migrated on first use.
- **Config warnings name the file.** They previously said to edit `config/email.json`, a path relative to an install directory the agent was never told. They now print the absolute path, and a failed write is reported instead of being swallowed.

### Changed
- **Mail tool arguments are validated by their declared zod schemas.** Every mail tool already published a zod `inputSchema` and then re-validated the same arguments through a separate hand-written layer. That layer ran outside the tool handler, so a bad argument came back as a JSON-RPC protocol error rather than a tool result an agent can read; validation failures are now ordinary `isError` results. Messages come from zod and differ in wording from the old ones — anything matching on mail validation text should be updated. `search_emails` still reports "At least one of 'subject', 'sender', 'after', or 'before' is required", and `after`/`before` must now parse as dates.
- **Unknown fields are ignored rather than rejected.** The old layer failed a call that carried an unexpected field; zod strips them, which is the behaviour every other server in this package already had.
- **`mail.ts` is now tool registration only** — 3,911 lines to 264. Its internals moved to `src/servers/mail/`: the JXA scripts, types, mailbox parsing, account config, Envelope Index queries, normalization, formatting, and the read and mutate implementations.

### Fixed
- **One mailbox-name algorithm, shared by TypeScript and the JXA scripts.** A read displays a mailbox by name and a mutation finds it by name, and the two implementations disagreed: ten hand-copied JXA versions split the URL path and dropped empty segments, while the TypeScript one decoded the path whole. They returned different names for a pathless URL, a trailing slash and a doubled slash — so a mailbox could list successfully and then fail to mutate with `invalid_handle`. The scripts now carry the TypeScript algorithm verbatim as a shared prelude, and a test runs both through `osascript` over the same URLs to keep them in step.
- **Both Envelope Index queries are built from one plan.** The unread and search builders had drifted apart while sharing 71 identical lines of join and column logic. The shared part is derived once; the generated SQL is unchanged, verified across 24 schema and argument combinations.

### Added
- Unit tests for the mail logic that had none: the SQL builders run against an in-memory Envelope Index fixture, and row normalization, the argument schemas and the search-criteria rule are covered directly.


### Changed
- **CI runs on every pull request**, not only those based on `main`. `pull_request: branches: [main]` filters on the base branch, so a stacked PR targeting the slice below it was skipped entirely; the runs such PRs appeared to get came from `gh stack submit` creating them against `main` and then retargeting.
- **CI refuses a version bump while `main`'s version is untagged.** This is how 0.6.0 was lost: it reached main, was never tagged, and was then superseded by 0.7.0, after which the release workflow's tag check could never pass for it. The guard fails the second bump with an explanation instead of leaving the first version stranded.

## [0.7.1] - 2026-09-21

### Changed
- **Reverted the `/bin/sh` launcher introduced in 0.7.0.** `bin/macos-tools.js` is again a three-line `#!/usr/bin/env bun` shim. The launcher 0.7.0 replaced was not failing: an absolute path in an MCP host config reaches it, and `env bun` resolves in the hosts actually in use. It was rewritten on an inferred failure rather than an observed one. Where bun is installed is the user's environment to configure, not something this package should probe for across five candidate directories. No config change is needed in either direction.

## [0.7.0] - 2026-09-19

### Added
- **Intel Mac support.** `bin/EventKitCLI` is now a universal binary (arm64 + x86_64). Previously `package.json` declared `os: darwin` with no `cpu`, so npm installed happily on an Intel Mac and `events`/`reminders` then failed with "EventKitCLI execution failed". `cpu` now declares both architectures.
- **`doctor` fails below macOS 14** instead of only printing the version, and names the five servers that keep working without `EventKitCLI`.
- **README: "The EventKitCLI binary"** documents what ships, the ad-hoc + Hardened Runtime signing model, and why macOS asks for Calendar and Reminders permission again after every update.

### Changed
- **`EventKitCLI` is built with an explicit macOS 14 deployment target.** It previously inherited the build host's target, which after the move to CI meant the published binary silently required whatever macOS the release runner ran — macOS 26 for the 0.6.0 pipeline. macOS 14 is the real floor: the EventKit APIs in use were introduced there. `LSMinimumSystemVersion` in `Info.plist` was `10.15` and is now `14.0`.
- `bun run build:swift` verifies that the binary contains both architectures, not merely that it contains one.
- The binary roughly doubles in size (728 KB to 1.45 MB); the packed tarball is 0.48 MB.
- **The release workflow pins npm** (12.0.2) instead of installing `npm@latest`, and CI pins the same version, so a green PR means the release will pack the same way.

### Fixed
- **The launcher no longer depends on bun being on the host's `PATH`.** `bin/macos-tools.js` was a `#!/usr/bin/env bun` script, and `bun install -g` symlinks the global `macos-mcp-tools` command straight at it, so the shebang is what the kernel runs. GUI MCP hosts do not inherit your shell `PATH` — they typically get `/usr/bin:/bin:/usr/sbin:/sbin`, and bun installs to none of those — so this only worked when a host happened to pass a fuller `PATH`. It is now `bin/macos-tools`, a `/bin/sh` script that resolves its own symlink and looks for bun on `PATH`, then in `$BUN_INSTALL/bin`, `~/.bun/bin`, `~/.cache/.bun/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. Host configs are unchanged: they point at the `macos-mcp-tools` symlink, which is re-created on upgrade.
- **`npx` and `npm install -g` now explain themselves.** The servers are TypeScript and need bun; under node the old shim failed with a syntax error, or with `env: bun: No such file or directory`. The launcher now exits 1 with instructions for installing bun, or for pointing an MCP host straight at a bun binary.
- **The release workflow could not publish.** `npm install -g npm@latest` floated onto npm 12, which changed `npm pack --json` from an array of tarballs to an object keyed by package name. The package manifest test parsed only the old shape, so the v0.6.0 release run failed at the test step. It now reads both shapes — contributors run whatever npm they have — and throws a named error rather than reporting an empty package if the shape changes again. Nothing was published or released by the failed run.


## [0.6.0] - 2026-09-19

> Never published. The v0.6.0 release run failed before it reached npm (see 0.7.0, "Fixed"), and by
> the time the pipeline was repaired `package.json` had moved on. Everything below ships in 0.7.0.


### Changed
- **`bin/EventKitCLI` is built by CI, not committed.** The binary is now gitignored and produced by `bun run build:swift` during the release workflow, so the published tarball's binary is built from the Swift source in the same commit rather than from whatever a maintainer last compiled locally. Contributors must run `bun run build:swift` once after cloning; `bun test` requires it. **On upgrade, macOS will ask for Calendar and Reminders permission again** — the binary is ad-hoc signed, so a rebuild changes its code signature and macOS treats it as new code.
- **`package.json` `files` uses globs.** The 26-entry hand-maintained allowlist became `src/**/*.ts` minus tests and integration fixtures, so source files added under `src/` ship without editing `package.json`. The allowlist had already dropped files from a release (0.0.3). The tarball is unchanged by this: the same 33 files ship.
- **`bun run build:swift` verifies what it produced**, failing if the signature does not validate or the binary reports no architecture.

### Added
- `src/package-manifest.test.ts`: packs the package and asserts that every tracked non-test source file, the entrypoint, the EventKit binary and the Swift build inputs are in the tarball, and that no test file is. Runs under `bun test`.

## [0.5.0] - 2026-09-19

### Added
- **`doctor` subcommand** (`macos-mcp-tools doctor`): checks runtime versions, installed version vs npm, the `EventKitCLI` binary and its architecture, Full Disk Access for Mail and Messages, Calendar/Reminders access, `pdftotext`, and every `macos-mcp-tools` entry in Claude Desktop and Claude Code configs (absolute, existing path, not via `bunx`/`npx`). Prints a fix for each problem; exit code 1 on failure.

### Changed
- **Release pipeline**: pushing a `v*` tag now stages the release on npm from GitHub Actions using trusted publishing (OIDC) with provenance, after verifying the tag matches `package.json` and running the full CI suite. No npm token exists in the repository or on maintainer machines, and CI cannot make a version live: a maintainer promotes the staged version with 2FA from npmjs.com or `npm stage approve`. Re-pushing a tag skips staging when that version is already live. See CONTRIBUTING "Releasing" for the one-time npmjs.com setup.
- **README**: the Updating step now clears Bun's cached package manifest before reinstalling (without it, `@latest` can silently keep the previous release for minutes after a publish) and points to `doctor`.

## [0.4.1] - 2026-09-18

### Changed
- **README**: installation now documents the only supported pattern for MCP hosts: a global `bun install -g` and an absolute launcher path in each host config. `bunx` is explicitly warned against because concurrent launches from a host corrupt its shared temp install and crash the servers on startup. Adds Claude Code instructions and an update procedure.

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
