# Contributing to macos-mcp-tools

Thank you for your interest in contributing!

## Development Setup

```bash
# Clone the repository
git clone https://github.com/<owner>/macos-mcp-tools.git
cd macos-mcp-tools

# Install dependencies
bun install

# Run tests
bun test

# Run the CLI
bun run src/cli.ts <subcommand>
```

## Project Structure

```
src/
├── cli.ts              # CLI entry point, dispatches to one server per subcommand
├── doctor.ts           # `doctor` subcommand: permission, binary and host-config checks
├── lib/
│   ├── jxa.ts          # Shared JXA helper for AppleScript execution
│   ├── doctor.ts       # Pure logic behind `doctor` (unit-tested)
│   ├── version.ts      # Package version read from package.json
│   └── eventkit/       # TypeScript bridge to the EventKitCLI Swift binary
├── integration/        # Opt-in stdio integration tests
└── servers/
    ├── mail.ts         # Apple Mail MCP server
    ├── contacts.ts     # Apple Contacts MCP server
    ├── notes.ts        # Apple Notes MCP server
    ├── memory.ts       # Memory store MCP server
    ├── messages.ts     # Apple Messages MCP server
    ├── events.ts       # Apple Calendar MCP server (EventKit)
    └── reminders.ts    # Apple Reminders MCP server (EventKit)
swift/
└── EventKitCLI.swift   # Swift source for bin/EventKitCLI (bun run build:swift)
```

## Scripts

```bash
bun run dev    # Run the CLI locally
bun test       # Run unit tests
bun run typecheck  # Run TypeScript checks
bun run test:integration  # Run opt-in integration tests
```

## Testing

- Unit tests use Bun's built-in test runner
- Test files: `src/servers/*.test.ts`
- Integration tests are opt-in and use isolated temporary data directories
- Tests cover helper logic only; JXA behavior requires manual testing

## Code Style

- TypeScript with strict mode enabled
- ES modules (`"type": "module"` in package.json)
- No semicolons

## Making Changes

1. Create a feature branch: `git checkout -b feature/my-feature`
2. Make your changes
3. Add tests for new functionality
4. Ensure tests pass: `bun test`
5. Commit with a clear message

## Pull Request Process

1. Update documentation if needed
2. Ensure all tests pass
3. PRs are reviewed within a few days

## Releasing

Publishing is automated. There is no npm token anywhere; the release workflow authenticates with npm trusted publishing (GitHub OIDC) and publishes with provenance.

1. Every merged PR or PR stack bumps `package.json` and adds a CHANGELOG section (see AGENTS.md).
2. After the merge, tag the merge commit with the same version and push the tag:

   ```bash
   git fetch origin main && git tag -a v0.5.0 origin/main -m "v0.5.0" && git push origin v0.5.0
   ```

3. `.github/workflows/release.yml` verifies the tag matches `package.json`, runs lint, tests, typecheck and integration, packs, publishes to npm with `--provenance`, and creates the GitHub release with the tarball attached. Re-pushing an existing tag is safe: the publish step is skipped when that version is already on npm.

**One-time setup (package owner):** on npmjs.com open the package → Settings → Publishing access → Trusted Publisher → GitHub Actions, and enter organization `HachiTogo`, repository `macos-mcp-tools`, workflow filename `release.yml`, environment blank. Until this is done the publish step fails with an authentication error and the GitHub release is not created; nothing is left half-published.

Local `npm publish` is no longer part of the process. If it is ever needed as a fallback, publish the tarball attached to the GitHub release, not a fresh local pack, so npm and GitHub carry identical bytes.

## Requirements

- macOS (required for JXA/AppleScript)
- Bun runtime 1.0.0+
