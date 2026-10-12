# AGENTS.md

## Commands
- Bun on macOS only. Entrypoint: `bun run src/cli.ts <mail|contacts|notes|memory|messages|events|reminders>`.
- `bun test` (single file: `bun test src/servers/mail.test.ts`), `bun run typecheck`, `bun run lint` (Biome; `bun run format` fixes).
- Opt-in: `bun run test:integration`; `test:integration:apps` hits live Apple apps.
- `bun run build:swift` builds the untracked `bin/EventKitCLI` (needs `swiftc`); `events`, `reminders` and `bun test` require it.
- Do not invent extra verification steps. CI builds the binary, then runs exactly `bun run lint`, `bun test`, `bun run typecheck` and `bun run test:integration`.

## Structure
- Single package. `src/cli.ts` is the only entrypoint and dynamically imports one stdio MCP server per subcommand.
- Servers: `src/servers/<name>.ts` registers tools; mail, memory and reminders keep their logic in `src/servers/<name>/`.
- Shared JXA helper: `src/lib/jxa.ts`. EventKit bridge: `src/lib/eventkit/`, which shells out to `bin/EventKitCLI`.
- `package.json` `files` globs `src/**/*.ts`; `src/package-manifest.test.ts` checks that new files ship.

## Development Guidance
- Every change lands through a pull request against `main`. Never push directly to `main`.
- Each PR or stack gets its own branch off `main`. Do not reuse a branch across unrelated changes.
- Do not bump `package.json`; add CHANGELOG entries under `## [Unreleased]`. `make release VERSION=x.y.z` opens a PR that promotes them and bumps once, sized to everything in it: patch for fixes, minor for features or pre-1.0 breaks, major past 1.0. `main`'s version always equals what npm serves.
- Keep each PR near 300 lines of code, excluding comments and tests. One reviewable concern per PR.
- Larger work splits into stacked PRs with `gh stack` (see `gh stack --help`): `gh stack init`, commit a slice, `gh stack add <branch>`, `gh stack submit`, `gh stack sync` after merges. Each slice must pass CI and stand alone.
- Style: TypeScript strict, ESM, no semicolons, enforced by Biome. Run `bun run format` before committing.
- Add or update unit tests for helper logic you touch. Update `README.md` when tool names or arguments change.
- Commit messages use conventional prefixes (`feat:`, `fix:`, `docs:`).

## Stateful Side Effects
- `mail.ts` reads `~/Library/Mail/V10/MailData/Envelope Index`; it mutates through JXA.
- Mail auto-writes `email.json` in the data dir (`MACOS_TOOLS_DATA_DIR`, else `~/.local/share/macos-tools/`) when missing or empty. A file that does not parse is reported, never overwritten.
- `messages.ts` reads `~/Library/Messages/chat.db` read-only and sends through JXA.
- `memory.ts` stores SQLite in the data dir. Use a temp dir when testing.
- `events.ts` and `reminders.ts` mutate real calendars and reminder lists through EventKit.

## Testing Reality
- Every server has unit tests; mail and messages SQL runs on fixture databases.
- `src/integration/servers.integration.test.ts` snapshots every server's `tools/list`, checks its hints and the README's tool lists; refresh intended changes with `RUN_INTEGRATION_TESTS=1 bun test src/integration -u`.
- It caps serialized `tools/list` size with a ratchet, `SCHEMA_BUDGET_BYTES`; change it on purpose.
- Nothing covers live JXA or EventKit behavior: verify against the real apps and say so in the PR.

## External Dependencies
- `fetch_email_attachment` needs `pdftotext`; `brew install poppler` if PDF extraction fails.
- `events` and `reminders` need Calendar and Reminders access.
