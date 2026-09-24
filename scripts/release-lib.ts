// Pure pieces of the release script, kept apart so they can be tested without git, gh or npm.

/** Release versions only. A hyphenated prerelease is a milestone tag, which never publishes. */
const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/

export const parseVersion = (value: string): [number, number, number] | undefined => {
  const match = RELEASE_VERSION.exec(value.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

export const compareVersions = (a: string, b: string): number => {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) throw new Error(`not a release version: ${left ? b : a}`)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}

/** Rewrites only the version field, so the rest of package.json keeps its formatting. */
export const setPackageVersion = (packageJson: string, version: string): string => {
  const pattern = /("version"\s*:\s*")[^"]*(")/
  if (!pattern.test(packageJson)) throw new Error("package.json has no version field")
  return packageJson.replace(pattern, `$1${version}$2`)
}

const UNRELEASED = "## [Unreleased]"

/** The entries waiting to ship: everything between `## [Unreleased]` and the next version heading. */
export const unreleasedEntries = (changelog: string): string => {
  const start = changelog.indexOf(UNRELEASED)
  if (start === -1) throw new Error("CHANGELOG.md has no ## [Unreleased] heading")
  const body = changelog.slice(start + UNRELEASED.length)
  const next = body.search(/^## \[/m)
  return (next === -1 ? body : body.slice(0, next)).trim()
}

/** Turns the pending entries into a dated version section and leaves an empty Unreleased above it. */
export const promoteUnreleased = (changelog: string, version: string, date: string): string => {
  if (!unreleasedEntries(changelog)) throw new Error("nothing under ## [Unreleased] to release")
  return changelog.replace(UNRELEASED, `${UNRELEASED}\n\n## [${version}] - ${date}`)
}

/**
 * The SemVer size the pending entries call for, per AGENTS.md: patch for fixes, minor for
 * features, and for breaking changes minor before 1.0 and major after. A suggestion only; the
 * release asks for confirmation before acting on it.
 */
export const suggestVersion = (current: string, changelog: string): string => {
  const parsed = parseVersion(current)
  if (!parsed) throw new Error(`not a release version: ${current}`)
  const [major, minor, patch] = parsed
  const entries = unreleasedEntries(changelog)
  const breaking = /\bBREAKING\b/.test(entries)
  const feature = /^### (Added|Changed|Removed)/m.test(entries)

  if (major >= 1 && breaking) return `${major + 1}.0.0`
  if (breaking || feature) return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/** The id npm prints when staging, as it appears in the release workflow's log. */
export const findStageId = (log: string): string | undefined =>
  /staged with id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(log)?.[1]

/** YYYY-MM-DD in local time, which is what the changelog's dates have always been. */
export const localDate = (date: Date = new Date()): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
