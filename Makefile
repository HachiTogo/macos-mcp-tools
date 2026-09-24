# Release and install shortcuts. See CONTRIBUTING.md, "Releasing".
.PHONY: publish publish-dry-run upgrade

# Optional: make publish VERSION=0.8.0. Without it, the version is suggested from the changelog
# and shown for confirmation before anything changes.
VERSION ?=

publish:
	@bun scripts/release.ts $(VERSION)

publish-dry-run:
	@bun scripts/release.ts $(VERSION) --dry-run

upgrade:
	bun pm cache rm && bun install -g @hachitogo/macos-mcp-tools@latest
