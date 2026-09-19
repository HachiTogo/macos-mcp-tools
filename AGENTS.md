# AGENTS.md

## Commands
- Bun on macOS only. Entrypoint: `bun run src/cli.ts <mail|contacts|notes|memory|messages|events|reminders>`.
- `bun test` (single file: `bun test src/servers/mail.test.ts`), `bun run typecheck`, `bun run lint` (Biome; `bun run format` fixes).
- Opt-in integration: `bun run test:integration`; `test:integration:apps` also hits live Apple apps.
- `bun run build:swift` builds `bin/EventKitCLI` from `swift/EventKitCLI.swift` (needs `swiftc`); `events` and `reminders` require it.
- Do not invent extra verification steps. CI runs exactly `bun run lint`, `bun test`, `bun run typecheck`, `bun run test:integration`.

## Structure
- Single package. `src/cli.ts` is the only entrypoint and dynamically imports one stdio MCP server per subcommand.
- Servers: `src/servers/{mail,contacts,notes,memory,messages,events,reminders}.ts`.
- Shared JXA helper: `src/lib/jxa.ts`. EventKit bridge: `src/lib/eventkit/`, which shells out to `bin/EventKitCLI`.
- `package.json` `files` globs `src/**/*.ts`, so new source files ship automatically; `src/package-manifest.test.ts` fails if one does not.

## Development Guidance
- Every change lands through a GitHub pull request against `main`. Never push directly to `main`.
- Each PR, or each PR stack, gets its own feature branch off `main`. Do not reuse a branch across unrelated changes.
- Every merged PR or PR stack carries one SemVer-compliant version bump sized to the scope and breadth of the change: patch for fixes, minor for features or breaking pre-1.0 changes, major once past 1.0. One bump per stack, not per slice.
- Keep each PR near 300 lines of code changed, excluding comments and tests. One reviewable concern per PR.
- Larger work splits into stacked PRs with `gh stack` (see `gh stack --help`): `gh stack init`, commit a slice, `gh stack add <branch>` per further slice, `gh stack submit`, `gh stack sync` after merges. Each slice must pass CI and stand alone.
- Style: TypeScript strict, ES modules, no semicolons, enforced by Biome (`biome.jsonc`). Run `bun run format` before committing.
- Add or update unit tests for helper logic you touch. Update `README.md` when tool names or arguments change.
- Commit messages use conventional prefixes (`feat:`, `fix:`, `docs:`).

## Stateful Side Effects
- `mail.ts` reads `~/Library/Mail/V10/MailData/Envelope Index` but mutates through JXA/`osascript`.
- `mail.ts` auto-writes `config/email.json`, resolved against the install directory, when it is missing or empty. `config/` is gitignored, so this cannot dirty the worktree. Treat it as generated state.
- `messages.ts` reads `~/Library/Messages/chat.db` (readonly SQLite) and sends through JXA/`osascript`.
- `memory.ts` stores SQLite in `MACOS_TOOLS_DATA_DIR` if set, else `~/.local/share/macos-tools/`. Point it at a temp dir when testing.
- `events.ts` and `reminders.ts` mutate real calendars and reminder lists through EventKit.

## Testing Reality
- Unit tests cover pure helpers: `src/servers/mail.test.ts`, `src/servers/memory.test.ts`, and six suites under `src/lib/eventkit/`.
- `src/integration/servers.integration.test.ts` runs the memory server over stdio in an isolated data dir. Live-app cases need `RUN_APP_INTEGRATION_TESTS=1`.
- No automated coverage for live JXA or EventKit behavior (`contacts`, `notes`, `messages`, `events`, `reminders`, mail mutations). Verify manually and say so in the PR.

## External Dependencies
- `fetch_email_attachment` uses `pdftotext`; `brew install poppler` if PDF extraction fails.
- `events` and `reminders` need Calendar and Reminders permission for the process running the server.
