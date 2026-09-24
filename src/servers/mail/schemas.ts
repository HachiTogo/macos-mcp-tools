// The zod schemas the tools validate against. They live apart from mail.ts so they can be tested:
// these carry rules that a hand-rolled argument layer used to enforce, and getting one of them
// subtly wrong is not something a type checker would catch.

import { z } from "zod"

import { DEFAULT_LIMIT, MAX_LIMIT } from "./constants"

export const handleSchema = z.object({
  accountId: z.string(),
  mailboxUrl: z.string(),
  mailId: z.string(),
})

export const emailsArraySchema = z
  .array(
    z.object({
      id: z.string(),
      subject: z.string().optional(),
      handle: handleSchema,
    }),
  )
  .min(1)

/**
 * Deliberately `.default()` without `.optional()`. Written the other way round, `optional` wraps
 * `default` and an absent `limit` parses as `undefined` rather than DEFAULT_LIMIT -- which is what
 * happened before, with the hand-rolled parser quietly supplying the real default.
 */
export const offsetSchema = z.number().int().min(0).default(0)

export const limitSchema = z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT)

/** `after`/`before` accept a bare date or a full timestamp; both must parse. */
export const isoDateString = (field: string) =>
  z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: `Invalid ${field} date. Use ISO 8601, for example "2026-09-01" or "2026-09-01T09:00:00Z".`,
  })

/**
 * search_emails needs at least one criterion. This is a rule about the object rather than any one
 * field, and `registerTool` takes a shape rather than an object, so there is nowhere in the schema
 * to hang it.
 */
export const hasSearchCriteria = (args: {
  subject?: string
  sender?: string
  after?: string
  before?: string
}): boolean => Boolean(args.subject || args.sender || args.after || args.before)
