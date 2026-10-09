import { describe, expect, test } from "bun:test"

import * as scripts from "./jxa-scripts"

describe("mail JXA scripts", () => {
  test("every script parses as JavaScript", () => {
    const sources = Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    expect(sources.length).toBeGreaterThan(10)
    for (const [name, source] of sources) {
      // `name` in the message says which script failed to parse.
      expect(() => new Function(source), name).not.toThrow()
    }
  })
})
