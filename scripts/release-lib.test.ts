import { describe, expect, test } from "bun:test"

import {
  compareVersions,
  findStageId,
  localDate,
  parseVersion,
  promoteUnreleased,
  setPackageVersion,
  suggestVersion,
  unreleasedEntries,
} from "./release-lib"

const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed
- A fix.

## [0.7.1] - 2026-09-21

### Changed
- Earlier work.
`

describe("versions", () => {
  test("parses release versions and refuses prereleases", () => {
    expect(parseVersion("0.8.0")).toEqual([0, 8, 0])
    expect(parseVersion("0.8.0-rc.1")).toBeUndefined()
    expect(parseVersion("v0.8.0")).toBeUndefined()
  })

  test("compares numerically, not as strings", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0)
    expect(compareVersions("0.8.0", "0.8.0")).toBe(0)
    expect(compareVersions("0.7.1", "0.8.0")).toBeLessThan(0)
  })
})

describe("setPackageVersion", () => {
  test("changes the version and nothing else", () => {
    const before = '{\n  "name": "x",\n  "version": "0.7.1",\n  "type": "module"\n}\n'
    expect(setPackageVersion(before, "0.8.0")).toBe('{\n  "name": "x",\n  "version": "0.8.0",\n  "type": "module"\n}\n')
  })

  test("leaves a dependency's version field alone", () => {
    const before = '{\n  "version": "0.7.1",\n  "dependencies": { "zod": { "version": "4.0.0" } }\n}'
    expect(setPackageVersion(before, "0.8.0")).toContain('"zod": { "version": "4.0.0" }')
  })
})

describe("changelog", () => {
  test("reads only the pending entries", () => {
    expect(unreleasedEntries(CHANGELOG)).toBe("### Fixed\n- A fix.")
  })

  test("dates the pending entries and leaves an empty Unreleased above them", () => {
    const promoted = promoteUnreleased(CHANGELOG, "0.7.2", "2026-09-24")
    expect(promoted).toContain("## [Unreleased]\n\n## [0.7.2] - 2026-09-24\n\n### Fixed\n- A fix.")
    expect(unreleasedEntries(promoted)).toBe("")
    expect(promoted).toContain("## [0.7.1] - 2026-09-21")
  })

  test("refuses to cut a release with nothing in it", () => {
    const empty = CHANGELOG.replace("### Fixed\n- A fix.\n\n", "")
    expect(() => promoteUnreleased(empty, "0.7.2", "2026-09-24")).toThrow(/nothing under/)
  })
})

describe("suggestVersion", () => {
  test("fixes alone are a patch", () => {
    expect(suggestVersion("0.7.1", CHANGELOG)).toBe("0.7.2")
  })

  test("added or changed behaviour is a minor", () => {
    expect(suggestVersion("0.7.1", CHANGELOG.replace("### Fixed", "### Added"))).toBe("0.8.0")
    expect(suggestVersion("0.7.1", CHANGELOG.replace("### Fixed", "### Changed"))).toBe("0.8.0")
  })

  test("a breaking change is a minor before 1.0 and a major after", () => {
    const breaking = CHANGELOG.replace("- A fix.", "- **BREAKING**: renamed a tool.")
    expect(suggestVersion("0.7.1", breaking)).toBe("0.8.0")
    expect(suggestVersion("1.2.3", breaking)).toBe("2.0.0")
  })

  test("ignores entries that have already shipped", () => {
    // "Changed" appears under 0.7.1, not under Unreleased, so this is still a patch.
    expect(suggestVersion("0.7.1", CHANGELOG)).toBe("0.7.2")
  })
})

describe("findStageId", () => {
  test("reads the id from the release workflow's log", () => {
    const log =
      "Stage npm release\t2026-09-21T17:34:19Z npm notice stage package @hachitogo/macos-mcp-tools@0.7.1 has been staged with tag latest\n" +
      "Stage npm release\t2026-09-21T17:34:19Z + @hachitogo/macos-mcp-tools@0.7.1 (staged with id 06055e14-fa51-48c4-a609-4d44f1233ab3)"
    expect(findStageId(log)).toBe("06055e14-fa51-48c4-a609-4d44f1233ab3")
  })

  test("finds nothing in a log that staged nothing", () => {
    expect(findStageId("0.7.1 is already live on npm; nothing to stage.")).toBeUndefined()
  })
})

test("localDate is zero-padded local time", () => {
  expect(localDate(new Date(2026, 0, 5))).toBe("2026-01-05")
})
