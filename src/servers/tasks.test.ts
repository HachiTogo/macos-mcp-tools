import { describe, expect, test } from "bun:test"

import { applyFlaggedToTags } from "./tasks"

describe("tasks pure helpers", () => {
  describe("applyFlaggedToTags", () => {
    test("returns tags unchanged when flagged is undefined", () => {
      expect(applyFlaggedToTags(["a", "b"], undefined)).toEqual(["a", "b"])
      expect(applyFlaggedToTags(["a", "flagged", "b"], undefined)).toEqual(["a", "flagged", "b"])
    })

    test("adds flagged tag when flagged=true and absent", () => {
      expect(applyFlaggedToTags(["a"], true)).toEqual(["a", "flagged"])
    })

    test("does not duplicate flagged tag when flagged=true and already present", () => {
      const result = applyFlaggedToTags(["a", "flagged"], true)
      expect(result.filter((tag) => tag === "flagged")).toHaveLength(1)
      expect(result).toContain("a")
    })

    test("removes flagged tag when flagged=false", () => {
      expect(applyFlaggedToTags(["a", "flagged", "b"], false)).toEqual(["a", "b"])
    })

    test("is a no-op when flagged=false and flagged tag absent", () => {
      expect(applyFlaggedToTags(["a", "b"], false)).toEqual(["a", "b"])
    })

    test("preserves order of non-flagged tags", () => {
      expect(applyFlaggedToTags(["x", "y", "z"], true)).toEqual(["x", "y", "z", "flagged"])
    })
  })
})
