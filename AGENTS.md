# AGENTS.md

## Commands
- Bun on macOS only. Entrypoint: `bun run src/cli.ts <mail|contacts|notes|memory|messages|events|reminders>`.
- `bun test` (single file: `bun test src/servers/mail.test.ts`), `bun run typecheck`, `bun run lint` (Biome; `bun run format` fixes).
- Opt-in: `bun run test:integration`; `test:integration:apps` hits live Apple apps.
- `bun run build:swift` builds the untracked `bin/EventKitCLI` (needs `swiftc`); `events`, `reminders` and `bun test` require it.
- Do not invent extra verification steps. CI builds the binary, then runs exactly `bun run lint`, `bun test`, `bun run typecheck` and `bun run test:integration`.

## Structure
- Single package. `src/cli.ts` is the only entrypoint and dynamically imports one stdio MCP server per subcommand.
- Servers: `src/servers/{mail,contacts,notes,memory,messages,events,reminders}.ts`. Mail is a module tree under `src/servers/mail/`; `mail.ts` only registers tools.
- Shared JXA helper: `src/lib/jxa.ts`. EventKit bridge: `src/lib/eventkit/`, which shells out to `bin/EventKitCLI`.
- `package.json` `files` globs `src/**/*.ts`, so new files ship automatically; `src/package-manifest.test.ts` fails if one does not.

## Development Guidance
- Every change lands through a pull request against `main`. Never push directly to `main`.
- Each PR or stack gets its own branch off `main`. Do not reuse a branch across unrelated changes.
- Do not bump `package.json`; add CHANGELOG entries under `## [Unreleased]`. `make publish` runs the release: it promotes them and bumps once, sized to everything in it: patch for fixes, minor for features or pre-1.0 breaks, major past 1.0. `main`'s version always equals what npm serves.
- Keep each PR near 300 lines of code, excluding comments and tests. One reviewable concern per PR.
- Larger work splits into stacked PRs with `gh stack` (see `gh stack --help`): `gh stack init`, commit a slice, `gh stack add <branch>`, `gh stack submit`, `gh stack sync` after merges. Each slice must pass CI and stand alone.
- Style: TypeScript strict, ESM, no semicolons, enforced by Biome (`biome.jsonc`). Run `bun run format` before committing.
- Add or update unit tests for helper logic you touch. Update `README.md` when tool names or arguments change.
- Commit messages use conventional prefixes (`feat:`, `fix:`, `docs:`).

## Stateful Side Effects
- `mail.ts` reads `~/Library/Mail/V10/MailData/Envelope Index` but mutates through JXA/`osascript`.
- Mail auto-writes `email.json` in the data dir (`MACOS_TOOLS_DATA_DIR`, else `~/.local/share/macos-tools/`) when missing or empty. A file that does not parse is reported, never overwritten.
- `messages.ts` reads `~/Library/Messages/chat.db` (readonly SQLite) and sends through JXA/`osascript`.
- `memory.ts` stores SQLite in `MACOS_TOOLS_DATA_DIR` if set, else `~/.local/share/macos-tools/`. Use a temp dir when testing.
- `events.ts` and `reminders.ts` mutate real calendars and reminder lists through EventKit.

## Testing Reality
- Unit tests cover pure helpers: four suites under `src/servers/mail/`, plus `mail.test.ts`, `memory.test.ts` and six under `src/lib/eventkit/`.
- `src/integration/servers.integration.test.ts` runs the memory server over stdio in a temp data dir. Live-app cases need `RUN_APP_INTEGRATION_TESTS=1`.
- No coverage for live JXA or EventKit behavior (`contacts`, `notes`, `messages`, `events`, `reminders`, mail mutations). Verify manually and say so in the PR.

## External Dependencies
- `fetch_email_attachment` needs `pdftotext`; `brew install poppler` if PDF extraction fails.
- `events` and `reminders` need Calendar and Reminders permission for the running process.
