import { z } from "zod"

/** The `offset` every paged list or search tool takes. Beside `limit` it needs no description. */
export const offsetArg = z.number().int().min(0).default(0)

/** One page of a fully fetched list: everything from `offset` on, or at most `limit` of it. */
export const paginate = <T>(items: T[], offset = 0, limit?: number): T[] =>
  items.slice(offset, limit === undefined ? undefined : offset + limit)
