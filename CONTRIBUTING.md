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

Ordinary PRs do not touch `package.json`; they add CHANGELOG entries under `## [Unreleased]`.
Bumping per merge strands versions: a bump that reaches `main` and is never tagged can never be
released, because the release workflow checks the tag against `package.json`.

To publish, run:

```bash
make publish                  # version suggested from the changelog, shown before anything happens
make publish VERSION=0.8.0    # or choose it
make publish-dry-run          # check everything and print the plan; changes nothing
```

It needs `gh` logged in, and npm 11.15.0 or newer. After one confirmation it:

1. Opens a release PR that bumps `package.json` and dates the Unreleased entries, then merges it
   once CI passes. The edit happens in a throwaway worktree, so your checkout is never touched.
2. Tags the release commit and pushes the tag.
3. Waits for `.github/workflows/release.yml`, which verifies the tag against `package.json`, builds
   and verifies `bin/EventKitCLI`, runs the full CI suite, packs, stages the release on npm with
   `--provenance`, and creates the GitHub release with the tarball attached.
4. **Approves it**, which is the one step that needs you. If you are logged in to npm
   (`npm whoami`), it runs `npm stage approve` and you enter your 2FA code. If not, it prints the
   package page and waits while you approve under **Staged Packages** there.

Every step checks whether it already happened, so if one fails, fix the cause and run
`make publish` again; it picks up where it stopped. Afterwards, `make upgrade` updates your own
global install.

The manual equivalent, if you ever need it: release PR as above; then
`git tag -a vX.Y.Z <release commit> -m vX.Y.Z && git push origin vX.Y.Z`; wait for the workflow;
then `npm stage approve <stage-id>`, with the id from the workflow log.

Between staging and approval the GitHub release exists but npm still serves the previous version.
`make publish` waits for approval, so the two only disagree while it is waiting on you.

CI refuses a pull request that bumps the version while main's current version has no tag, because
that is how 0.6.0 was stranded: it reached main, was never tagged, and was then superseded by 0.7.0,
after which the tag check in step 3 could never pass for it. If you hit that failure, either release
the pending version first or drop your bump and fold the changes into it.

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

## Marking a milestone without publishing

A SemVer prerelease tag does not trigger the release workflow, so a point in history can be pinned
and tracked without shipping anything:

```bash
git tag -a v0.8.0-rc.1 -m "WS2 complete" && git push origin v0.8.0-rc.1
```

`release.yml` matches `v*` and excludes `v*-*`, so anything with a hyphen after the version --
`-rc.1`, `-beta.2`, `-alpha` -- is ignored. Release tags have no hyphen and still publish.

Nothing else needs to change for one: `package.json` can stay on the published version, since
nothing reads it for a tag the workflow ignores. Set it to the prerelease version instead if you
want `doctor` and the tarball to say so.

Local `npm publish` is not part of the process and is blocked by the settings above.

## Requirements

- macOS 14 or newer (required for JXA/AppleScript, and the floor for `EventKitCLI`)
- Bun runtime 1.0.0+
- Xcode Command Line Tools, for `bun run build:swift`

`bun run build:swift` compiles one slice per architecture with an explicit
`-target <arch>-apple-macos14.0`, lipos them into a universal binary, signs it ad-hoc with
Hardened Runtime and the entitlements file, then verifies the signature and that both slices are
present. Hardened Runtime is what lets macOS show the EventKit permission dialog when the binary
runs under a GUI host. Because the signature is ad-hoc, every rebuild changes the binary's identity
as far as TCC is concerned, so you will be asked for Calendar and Reminders access again after each
build. That also applies to users after each release; README explains it under "The EventKitCLI
binary".
