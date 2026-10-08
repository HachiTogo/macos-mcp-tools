import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { isoDateString, parseLocalDate } from "./dates"

// CI runs in UTC, where local and UTC midnight coincide and the bug cannot show. Pin a zone west of
// UTC so a bare date read as UTC lands on the previous evening and fails these tests.
const DEFAULT_TZ = process.env.TZ

beforeEach(() => {
  process.env.TZ = "America/Los_Angeles"
})

afterEach(() => {
  if (DEFAULT_TZ) {
    process.env.TZ = DEFAULT_TZ
  } else {
    delete process.env.TZ
  }
})

describe("parseLocalDate", () => {
  test("a bare date means local midnight, not UTC midnight", () => {
    const parsed = parseLocalDate("2026-10-01")
    expect(parsed.getTime()).toBe(new Date(2026, 9, 1).getTime())
    expect(parsed.toISOString()).toBe("2026-10-01T07:00:00.000Z")
  })

  test("an explicit zone is honoured rather than reinterpreted", () => {
    expect(parseLocalDate("2026-10-01T00:00:00Z").toISOString()).toBe("2026-10-01T00:00:00.000Z")
    expect(parseLocalDate("2026-10-01T09:00:00-04:00").toISOString()).toBe("2026-10-01T13:00:00.000Z")
  })

  test("a timestamp without a zone keeps Date's local reading", () => {
    expect(parseLocalDate("2026-10-01T09:30:00").getTime()).toBe(new Date(2026, 9, 1, 9, 30).getTime())
  })
})

describe("isoDateString", () => {
  const schema = isoDateString("from_date")

  test("accepts a bare date and a full timestamp", () => {
    expect(schema.safeParse("2026-10-01").success).toBe(true)
    expect(schema.safeParse("2026-10-01T09:00:00Z").success).toBe(true)
  })

  test("rejects text Date cannot parse, naming the field", () => {
    const result = schema.safeParse("last week")
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain("Invalid from_date date")
  })
})
