# Contributing to macos-mcp-tools

Thank you for your interest in contributing!

## Development Setup

```bash
# Clone the repository
git clone https://github.com/<owner>/macos-mcp-tools.git
cd macos-mcp-tools

# Install dependencies
bun install

# Build the EventKit binary (needs Xcode Command Line Tools).
# bin/EventKitCLI is a build output, not a tracked file, so a fresh clone has none
# and `bun test` fails until you build it once.
bun run build:swift

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

Publishing is automated up to a deliberate human gate. There is no npm token anywhere: the release
workflow authenticates with npm trusted publishing (GitHub OIDC) and stages the release with
provenance. CI cannot make a version live on its own.

1. Every merged PR or PR stack bumps `package.json` and adds a CHANGELOG section (see AGENTS.md).
2. After the merge, tag the merge commit with the same version and push the tag:

   ```bash
   git fetch origin main && git tag -a v0.5.0 origin/main -m "v0.5.0" && git push origin v0.5.0
   ```

3. `.github/workflows/release.yml` verifies the tag matches `package.json`, builds and verifies
   `bin/EventKitCLI` from the tagged Swift source, runs lint, tests, typecheck and integration,
   packs, stages the release on npm with `--provenance`, and creates the GitHub release with the
   tarball attached. The job summary links to the approval step.
4. **Approve it.** The staged version is not installable until a maintainer promotes it. On
   npmjs.com open the package → **Staged Packages** → Approve, or run `npm stage list` and then
   `npm stage approve <stage-id>`. Either route prompts for 2FA.

Between steps 3 and 4 the GitHub release exists but npm still serves the previous version. Approve
promptly so the two do not disagree for long.

Re-pushing a tag whose version is already live is safe; staging is skipped. Re-pushing one that is
still awaiting approval fails, because a staged version already occupies that version number. Reject
the staged version first, or bump.

**One-time setup (package owner)**, on npmjs.com under the package's Settings:

- **Trusted publishing** → GitHub Actions, with organization `HachiTogo`, repository
  `macos-mcp-tools`, workflow filename `release.yml`, environment blank. Leave direct publishing
  unchecked so that CI can only stage.
- **Publishing access** → require two-factor authentication and disallow bypass-2FA tokens. This
  governs token auth only and does not affect trusted publishing.

Until trusted publishing is configured the staging step fails with a 404 from the registry (npm's
response for an unauthorized write) and the GitHub release is not created; nothing is left
half-published.

Local `npm publish` is not part of the process and is blocked by the settings above.

## Requirements

- macOS (required for JXA/AppleScript)
- Bun runtime 1.0.0+
