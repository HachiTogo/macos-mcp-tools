# Release shortcuts. See CONTRIBUTING.md, "Releasing".
.PHONY: release tag upgrade

# Opens the release PR: bumps package.json and dates the changelog's Unreleased entries.
release:
	@test -n "$(VERSION)" || { echo "usage: make release VERSION=x.y.z"; exit 1; }
	git switch main && git pull
	git switch -c release/v$(VERSION)
	perl -0pi -e 's/"version": "[^"]*"/"version": "$(VERSION)"/' package.json
	DATE=$$(date +%F); perl -0pi -e "s/^## \\[Unreleased\\]\\n/## [Unreleased]\\n\\n## [$(VERSION)] - $$DATE\\n/m" CHANGELOG.md
	git commit -am "chore(release): $(VERSION)"
	git push -u origin release/v$(VERSION)
	gh pr create --fill

# After the release PR merges: tag main's version, which starts the release workflow.
tag:
	git switch main && git pull
	V=$$(node -p "require('./package.json').version"); git tag -a "v$$V" -m "v$$V" && git push origin "v$$V"

upgrade:
	bun pm cache rm && bun install -g @hachitogo/macos-mcp-tools@latest
