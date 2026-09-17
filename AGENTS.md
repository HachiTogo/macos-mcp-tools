# AGENTS.md

## Commands
- Runtime is Bun on macOS only. Local entrypoint: `bun run src/cli.ts <mail|contacts|notes|memory|messages|events|reminders>`.
- Unit tests: `bun test`. Single file: `bun test src/servers/mail.test.ts`.
- Typecheck: `bun run typecheck`.
- Integration tests (opt-in): `bun run test:integration`. Use `test:integration:apps` to also hit live Apple apps.
- Build the EventKit helper: `bun run build:swift` (needs `swiftc`; writes `bin/EventKitCLI`, required by `events` and `reminders`).
- Do not invent extra verification steps. CI runs exactly `bun test`, `bun run typecheck`, and `bun run test:integration`.

## Structure
- Single-package repo. `src/cli.ts` is the only entrypoint and dynamically imports one stdio MCP server per subcommand.
- Servers: `src/servers/{mail,contacts,notes,memory,messages,events,reminders}.ts`.
- Shared JXA helper: `src/lib/jxa.ts`. EventKit bridge: `src/lib/eventkit/`, which shells out to `bin/EventKitCLI` compiled from `swift/EventKitCLI.swift`.
- Published files are listed explicitly in `package.json` `files`. Add new source files there or releases will omit them.

## Development Guidance
- Every change lands through a GitHub pull request against `main`. Never push directly to `main`.
- Each PR, or each PR stack, gets its own feature branch off `main`. Do not reuse a branch across unrelated changes.
- Keep each PR to roughly 300 lines of code changed, not counting comments or tests. One reviewable concern per PR.
- Work needing more than that must be split into a chain of stacked PRs with `gh stack` (see `gh stack --help`): `gh stack init`, commit a slice, `gh stack add <branch>` for each further slice, `gh stack submit`, then `gh stack sync` after merges. Each slice must pass CI and make sense on its own.
- Style: TypeScript strict mode, ES modules, no semicolons. Match the surrounding file.
- Add or update unit tests for helper logic you touch. Update `README.md` when tool names or arguments change.
- Commit messages use conventional prefixes (`feat:`, `fix:`, `docs:`), as in the git log.

## Stateful Side Effects
- `mail.ts` reads Apple Mail data from `~/Library/Mail/V10/MailData/Envelope Index` but uses JXA/`osascript` for mutations and attachments.
- `mail.ts` auto-creates or rewrites repo-local `config/email.json` when it is missing or empty, so mail reads can dirty the worktree. Treat that file as generated state unless the task is about default mailbox classification.
- `messages.ts` reads `~/Library/Messages/chat.db` (readonly SQLite) and sends through JXA/`osascript`.
- `memory.ts` stores SQLite data in `MACOS_TOOLS_DATA_DIR` if set, else `~/.local/share/macos-tools/`. Point the env var at a temp dir when testing.
- `events.ts` and `reminders.ts` mutate the user's real calendars and reminder lists through EventKit.

## Testing Reality
- Unit tests cover helper logic only: `src/servers/mail.test.ts` and `src/servers/memory.test.ts`.
- `src/integration/servers.integration.test.ts` runs the memory server over stdio with an isolated data dir. Live-app cases are skipped unless `RUN_APP_INTEGRATION_TESTS=1`.
- There is no automated coverage for live JXA or EventKit behavior (`contacts`, `notes`, `messages`, `events`, `reminders`, mail mutations/attachments). Verify those manually and say so in the PR.

## External Dependencies
- `fetch_email_attachment` uses `pdftotext` in `text` mode. Run `brew install poppler` if PDF extraction fails.
- `events` and `reminders` need Calendar and Reminders permission granted to the process running the server.
