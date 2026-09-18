import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test"
import { getWeekStart, parseReminderDueDate } from "./date-utils.js"

describe("getWeekStart", () => {
  // Wednesday, January 17, 2024 at noon
  const FIXED_DATE = new Date("2024-01-17T12:00:00Z")

  beforeEach(() => {
    setSystemTime(FIXED_DATE)
  })

  afterEach(() => {
    setSystemTime()
  })

  describe("week start behavior", () => {
    it("returns a date at the beginning of the day (midnight)", () => {
      const result = getWeekStart()
      expect(result.getHours()).toBe(0)
      expect(result.getMinutes()).toBe(0)
      expect(result.getSeconds()).toBe(0)
    })

    it("returns a date in the past or today (never future)", () => {
      const result = getWeekStart()
      expect(result.getTime()).toBeLessThanOrEqual(FIXED_DATE.getTime())
    })

    it("returns a date within 7 days of the fixed date", () => {
      const result = getWeekStart()
      const daysDiff = (FIXED_DATE.getTime() - result.getTime()) / (1000 * 60 * 60 * 24)
      expect(daysDiff).toBeLessThan(7)
      expect(daysDiff).toBeGreaterThanOrEqual(0)
    })
  })
})

describe("parseReminderDueDate", () => {
  it("returns undefined for empty values", () => {
    expect(parseReminderDueDate(undefined)).toBeUndefined()
    expect(parseReminderDueDate("")).toBeUndefined()
  })

  it("parses date-only strings as local midnight", () => {
    const parsed = parseReminderDueDate("2024-01-15")
    const expected = new Date(2024, 0, 15)
    expect(parsed?.getTime()).toBe(expected.getTime())
  })

  it("parses local datetime strings without timezone as local time", () => {
    const parsed = parseReminderDueDate("2024-01-15 09:30:00")
    const expected = new Date(2024, 0, 15, 9, 30, 0)
    expect(parsed?.getTime()).toBe(expected.getTime())
  })

  it("parses ISO timestamps with timezone offsets", () => {
    const parsed = parseReminderDueDate("2024-01-15T10:00:00Z")
    expect(parsed?.toISOString()).toBe("2024-01-15T10:00:00.000Z")
  })

  it("normalizes date-only strings that include timezone offsets", () => {
    const parsed = parseReminderDueDate("2024-01-15+08:00")
    expect(parsed?.toISOString()).toBe("2024-01-14T16:00:00.000Z")
  })

  it("handles timezone offsets without a colon", () => {
    const parsed = parseReminderDueDate("2024-01-15 10:00:00+0800")
    expect(parsed?.toISOString()).toBe("2024-01-15T02:00:00.000Z")
  })

  describe("edge cases", () => {
    it("returns undefined for invalid dates", () => {
      // February 30th doesn't exist
      expect(parseReminderDueDate("2025-02-30")).toBeUndefined()
      // Month 13 doesn't exist
      expect(parseReminderDueDate("2025-13-01")).toBeUndefined()
      // Day 32 doesn't exist
      expect(parseReminderDueDate("2025-01-32")).toBeUndefined()
    })

    it("handles leap year dates correctly", () => {
      // 2024 is a leap year, Feb 29 is valid
      const leapYear = parseReminderDueDate("2024-02-29")
      expect(leapYear).toBeDefined()
      expect(leapYear?.getMonth()).toBe(1) // February
      expect(leapYear?.getDate()).toBe(29)

      // 2025 is not a leap year, Feb 29 is invalid
      const nonLeapYear = parseReminderDueDate("2025-02-29")
      expect(nonLeapYear).toBeUndefined()
    })

    it("handles various timezone offset formats", () => {
      // +HH:MM format
      const colonFormat = parseReminderDueDate("2024-01-15T10:00:00+05:30")
      expect(colonFormat?.toISOString()).toBe("2024-01-15T04:30:00.000Z")

      // +HHMM format
      const noColonFormat = parseReminderDueDate("2024-01-15T10:00:00+0530")
      expect(noColonFormat?.toISOString()).toBe("2024-01-15T04:30:00.000Z")

      // +HH format
      const hourOnlyFormat = parseReminderDueDate("2024-01-15T10:00:00+05")
      expect(hourOnlyFormat?.toISOString()).toBe("2024-01-15T05:00:00.000Z")

      // Negative offset
      const negativeOffset = parseReminderDueDate("2024-01-15T10:00:00-05:00")
      expect(negativeOffset?.toISOString()).toBe("2024-01-15T15:00:00.000Z")
    })

    it("handles whitespace variations", () => {
      // Tab separator
      const tabSeparator = parseReminderDueDate("2024-01-15\t10:00:00")
      expect(tabSeparator).toBeDefined()

      // Multiple spaces
      const multipleSpaces = parseReminderDueDate("2024-01-15  10:00:00")
      expect(multipleSpaces).toBeDefined()

      // Leading/trailing whitespace
      const withWhitespace = parseReminderDueDate("  2024-01-15 10:00:00  ")
      expect(withWhitespace).toBeDefined()
    })

    it("handles time without seconds", () => {
      const parsed = parseReminderDueDate("2024-01-15 10:30")
      expect(parsed).toBeDefined()
      expect(parsed?.getHours()).toBe(10)
      expect(parsed?.getMinutes()).toBe(30)
      expect(parsed?.getSeconds()).toBe(0)
    })

    it("returns undefined for malformed input", () => {
      expect(parseReminderDueDate("not-a-date")).toBeUndefined()
      expect(parseReminderDueDate("2024/01/15")).toBeUndefined() // Wrong separator
      expect(parseReminderDueDate("15-01-2024")).toBeUndefined() // Wrong order
    })
  })
})
