import { describe, expect, it } from "bun:test"
import { CliUserError, createErrorMessage, nullToUndefined } from "./helpers.js"
import { ValidationError } from "./schemas.js"

describe("helpers", () => {
  describe("nullToUndefined", () => {
    it("should convert null values to undefined for specified fields", () => {
      const obj = {
        id: "123",
        title: "Test",
        notes: null,
        url: null,
        dueDate: "2024-01-01",
      }

      const result = nullToUndefined(obj, ["notes", "url"])

      expect(result.id).toBe("123")
      expect(result.title).toBe("Test")
      expect(result.notes).toBeUndefined()
      expect(result.url).toBeUndefined()
      expect(result.dueDate).toBe("2024-01-01")
    })

    it("should not modify non-null values", () => {
      const obj = {
        id: "123",
        notes: "Some notes",
        url: "https://example.com",
      }

      const result = nullToUndefined(obj, ["notes", "url"])

      expect(result.notes).toBe("Some notes")
      expect(result.url).toBe("https://example.com")
    })

    it("should not modify fields not in the list", () => {
      const obj = {
        id: "123",
        notes: null,
        otherField: null,
      }

      const result = nullToUndefined(obj, ["notes"])

      expect(result.notes).toBeUndefined()
      expect(result.otherField).toBeNull()
    })

    it("should handle empty fields array", () => {
      const obj = {
        id: "123",
        notes: null,
      }

      const result = nullToUndefined(obj, [])

      expect(result.notes).toBeNull()
    })

    it("should create a new object and not mutate the original", () => {
      const obj = {
        id: "123",
        notes: null,
      }

      const result = nullToUndefined(obj, ["notes"])

      expect(result).not.toBe(obj)
      expect(obj.notes).toBeNull()
      expect(result.notes).toBeUndefined()
    })
  })

  describe("createErrorMessage", () => {
    it("prefixes the operation and keeps the underlying message", () => {
      expect(createErrorMessage("read calendar events", new Error("Event with ID 'x' not found."))).toBe(
        "read calendar events failed: Event with ID 'x' not found.",
      )
    })

    it("passes permission errors through", () => {
      const message = "Calendar permission denied. Grant access in System Settings > Privacy & Security"
      expect(createErrorMessage("read calendar events", new Error(message))).toBe(
        `read calendar events failed: ${message}`,
      )
    })

    it("uses validation and user error messages verbatim after the prefix", () => {
      expect(createErrorMessage("create reminder", new ValidationError("title is required"))).toBe(
        "create reminder failed: title is required",
      )
      expect(createErrorMessage("create reminder", new CliUserError('List "Work" not found'))).toBe(
        'create reminder failed: List "Work" not found',
      )
    })

    it("never hides the detail behind a generic string", () => {
      expect(createErrorMessage("update event", new Error("boom"))).toBe("update event failed: boom")
      expect(createErrorMessage("update event", "not an Error object")).toBe("update event failed: not an Error object")
    })
  })
})
