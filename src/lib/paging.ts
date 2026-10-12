import { z } from "zod"

/** The `offset` every paged list or search tool takes, worded the same everywhere. `noun` names what is skipped. */
export const offsetArg = (noun: string) =>
  z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(`Skip this many matching ${noun} before returning; use with limit to page.`)

/** One page of a fully fetched list: everything from `offset` on, or at most `limit` of it. */
export const paginate = <T>(items: T[], offset = 0, limit?: number): T[] =>
  items.slice(offset, limit === undefined ? undefined : offset + limit)
