// Date arguments shared by the servers that filter by time. Results are shown in local time, so a
// bound an agent writes as a bare date has to mean the user's day, not UTC's.

import { z } from "zod"

const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * A bare `YYYY-MM-DD` means midnight where the user is, not UTC: `new Date("2026-09-01")` is 17:00
 * the previous day in Pacific time. Anything carrying a time or a zone is left to Date, which
 * honours it. Input Date cannot parse comes back as an invalid Date; `isoDateString` rejects it
 * before it gets here.
 */
export const parseLocalDate = (value: string): Date => {
  const bareDate = BARE_DATE.exec(value)
  if (bareDate) {
    const [, year, month, day] = bareDate
    return new Date(Number(year), Number(month) - 1, Number(day))
  }
  return new Date(value)
}

/** A date argument: a bare date or a full timestamp, which must parse. */
export const isoDateString = (field: string) =>
  z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: `Invalid ${field} date. Use ISO 8601, for example "2026-09-01" or "2026-09-01T09:00:00Z".`,
  })

// A calendar date, optionally a time (to the minute, second or fraction) and a zone.
const ISO_8601 = /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

/** True when the YYYY-MM-DD part names a real day: Date rolls 2026-02-30 over to March and has no month 13. */
const isCalendarDate = (day: string) => {
  const date = new Date(`${day}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day
}

/**
 * A timestamp kept as text and compared as text, so it must be ISO 8601 rather than anything Date
 * happens to parse: "October 8, 2026" parses but sorts wrongly, and "yesterday" does not parse at all.
 */
export const isoTimestampString = (field: string) =>
  z.string().refine(
    (value) => {
      const match = ISO_8601.exec(value)
      return match !== null && isCalendarDate(match[1]) && !Number.isNaN(Date.parse(value))
    },
    {
      message: `Invalid ${field}: use an ISO 8601 date or timestamp, such as "2026-10-08" or "2026-10-08T14:30:00-07:00". Convert relative dates such as "yesterday" to a date first.`,
    },
  )
