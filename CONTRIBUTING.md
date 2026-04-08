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
├── cli.ts           # CLI entry point, handles subcommands
├── lib/
│   └── jxa.ts       # Shared JXA helper for AppleScript execution
└── servers/
    ├── mail.ts      # Apple Mail MCP server
    ├── contacts.ts  # Apple Contacts MCP server
    ├── notes.ts     # Apple Notes MCP server
    ├── tasks.ts     # Task manager MCP server
    └── memory.ts    # Memory store MCP server
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

## Requirements

- macOS (required for JXA/AppleScript)
- Bun runtime 1.0.0+
