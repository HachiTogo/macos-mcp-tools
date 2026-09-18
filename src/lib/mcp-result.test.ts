import { describe, expect, test } from "bun:test"

import { errorMessage, errorResult, jsonResult, runTool, textResult } from "./mcp-result"

describe("errorMessage", () => {
  test("uses Error.message and stringifies everything else", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom")
    expect(errorMessage("plain")).toBe("plain")
    expect(errorMessage(42)).toBe("42")
    expect(errorMessage(undefined)).toBe("undefined")
  })
})

describe("textResult", () => {
  test("wraps text and omits structuredContent when absent", () => {
    expect(textResult("hi")).toEqual({ content: [{ type: "text", text: "hi" }] })
  })

  test("carries structuredContent when given", () => {
    const result = textResult("hi", { a: 1 })
    expect(result.structuredContent).toEqual({ a: 1 })
    expect(result.isError).toBeUndefined()
  })
})

describe("jsonResult", () => {
  test("pretty-prints objects and carries them verbatim", () => {
    const result = jsonResult({ total: 2, items: ["a", "b"] })
    expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify({ total: 2, items: ["a", "b"] }, null, 2) })
    expect(result.structuredContent).toEqual({ total: 2, items: ["a", "b"] })
  })

  test("wraps arrays and scalars so structuredContent is always an object", () => {
    expect(jsonResult(["x"]).structuredContent).toEqual({ result: ["x"] })
    expect(jsonResult("ok").structuredContent).toEqual({ result: "ok" })
    expect(jsonResult(null).structuredContent).toEqual({ result: null })
  })
})

describe("errorResult", () => {
  test("prefixes the operation and sets isError", () => {
    expect(errorResult("list_folders", new Error("Not authorized"))).toEqual({
      content: [{ type: "text", text: "list_folders failed: Not authorized" }],
      isError: true,
    })
  })
})

describe("runTool", () => {
  test("passes successful results through untouched", async () => {
    const result = await runTool("op", () => textResult("done"))
    expect(result).toEqual({ content: [{ type: "text", text: "done" }] })
  })

  test("converts sync and async throws into error results", async () => {
    const sync = await runTool("op", () => {
      throw new Error("sync fail")
    })
    expect(sync).toEqual({ content: [{ type: "text", text: "op failed: sync fail" }], isError: true })

    const async = await runTool("op", async () => {
      throw "async fail"
    })
    expect(async.isError).toBe(true)
    expect(async.content[0]).toEqual({ type: "text", text: "op failed: async fail" })
  })
})
