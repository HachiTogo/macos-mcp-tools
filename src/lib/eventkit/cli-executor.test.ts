import { describe, expect, it } from "bun:test"
import { CliPermissionError, parseCliOutput } from "./cli-executor.js"
import { CliUserError } from "./helpers.js"

describe("parseCliOutput", () => {
  it("returns the result of a successful call", () => {
    expect(parseCliOutput<number[]>(JSON.stringify({ status: "success", result: [1, 2] }))).toEqual([1, 2])
  })

  it("turns a permission failure into CliPermissionError for its domain, from the code rather than the wording", () => {
    for (const domain of ["calendars", "reminders"] as const) {
      const output = JSON.stringify({ status: "error", message: "anything", code: "permission_denied", domain })
      expect(() => parseCliOutput(output)).toThrow(CliPermissionError)
      try {
        parseCliOutput(output)
      } catch (error) {
        expect((error as CliPermissionError).domain).toBe(domain)
      }
    }
  })

  it("reports any other failure as a CliUserError with the CLI's message", () => {
    const output = JSON.stringify({ status: "error", message: "Event with ID 'x' not found." })
    expect(() => parseCliOutput(output)).toThrow(CliUserError)
    expect(() => parseCliOutput(output)).toThrow("Event with ID 'x' not found.")
  })

  it("names output that is not JSON", () => {
    expect(() => parseCliOutput("not json")).toThrow("EventKitCLI execution failed: Invalid CLI output")
  })
})
