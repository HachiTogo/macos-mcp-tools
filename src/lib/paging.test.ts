import { describe, expect, test } from "bun:test"

import { offsetArg, paginate } from "./paging"

describe("paginate", () => {
  const items = ["a", "b", "c", "d", "e"]

  test("pages by offset and limit, with no overlap between consecutive pages", () => {
    expect(paginate(items, 0, 2)).toEqual(["a", "b"])
    expect(paginate(items, 2, 2)).toEqual(["c", "d"])
    expect([...paginate(items, 0, 2), ...paginate(items, 2, 2)]).toEqual(paginate(items, 0, 4))
  })

  test("with no limit returns everything from the offset", () => {
    expect(paginate(items)).toEqual(items)
    expect(paginate(items, 3)).toEqual(["d", "e"])
  })

  test("an offset past the end is an empty page", () => {
    expect(paginate(items, 9, 2)).toEqual([])
  })
})

describe("offsetArg", () => {
  test("defaults to 0 and rejects negatives", () => {
    expect(offsetArg.parse(undefined)).toBe(0)
    expect(() => offsetArg.parse(-1)).toThrow()
  })
})
