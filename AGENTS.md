# AGENTS.md

## Commands
- Runtime is Bun on macOS only. Local entrypoint: `bun run src/cli.ts <mail|contacts|notes|tasks|memory>`.
- Full tests: `bun test`
- Single test file: `bun test src/servers/mail.test.ts` or `bun test src/servers/memory.test.ts`
- Do not invent extra verification steps: use the repo's existing `bun test` and `bun run typecheck` checks.

## Structure
- This is a single-package repo. `src/cli.ts` is the only entrypoint and dynamically imports one stdio MCP server per subcommand.
- Main server files are `src/servers/mail.ts`, `contacts.ts`, `notes.ts`, `tasks.ts`, and `memory.ts`.
- Shared JXA helper lives in `src/lib/jxa.ts`.

## Stateful Side Effects
- `mail.ts` reads Apple Mail query data from `~/Library/Mail/V10/MailData/Envelope Index`, but uses JXA/`osascript` for mutations and attachment access.
- `mail.ts` auto-creates or rewrites repo-local `config/email.json` when the config is missing or empty, so running mail reads can dirty the worktree.
- Treat `config/email.json` as local/generated state unless the task is explicitly about changing default mailbox classification.
- `tasks.ts` and `memory.ts` resolve their SQLite data dir in this order: `MACOS_TOOLS_DATA_DIR` -> existing `.opencode/data` in the cwd -> `~/.local/share/macos-tools/`.

## Testing Reality
- Automated tests only cover helper logic in `src/servers/mail.test.ts` and `src/servers/memory.test.ts`.
- There is no automated coverage for live JXA behavior (`contacts`, `notes`, mail mutations/attachments) or end-to-end `tasks`/`memory` database flows, so those changes need manual verification.

## External Dependency
- `fetch_email_attachment` uses `pdftotext` for PDF-to-text extraction in `text` mode; install it with `brew install poppler` if PDF extraction fails.
