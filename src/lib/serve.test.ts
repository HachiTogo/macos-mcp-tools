import { describe, expect, test } from "bun:test"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"

import { leanSchema, leanToolList } from "./serve"

const MAX = Number.MAX_SAFE_INTEGER

describe("leanSchema", () => {
  test("drops $schema, empty or false additionalProperties, and the safe-integer bounds", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0, maximum: MAX },
        delta: { type: "integer", minimum: -MAX, maximum: MAX },
        item: { type: "object", properties: {}, additionalProperties: {} },
      },
      additionalProperties: false,
    }
    expect(leanSchema(schema)).toEqual({
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
        delta: { type: "integer" },
        item: { type: "object", properties: {} },
      },
    })
  })

  test("keeps an additionalProperties that constrains values, and never drops a property by its name", () => {
    const schema = {
      type: "object",
      properties: { $schema: { type: "string" }, maximum: { type: "number" } },
      additionalProperties: { type: "string" },
    }
    expect(leanSchema(schema)).toEqual(schema)
  })
})

describe("leanToolList", () => {
  test("leans a tools/list result without mutating it, and passes other messages through", () => {
    const listed = {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "t", inputSchema: { $schema: "x", type: "object" } }] },
    } as JSONRPCMessage
    const before = JSON.stringify(listed)
    expect(leanToolList(listed)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "t", inputSchema: { type: "object" } }] },
    } as JSONRPCMessage)
    expect(JSON.stringify(listed)).toBe(before)

    const other = { jsonrpc: "2.0", id: 2, result: { content: [] } } as JSONRPCMessage
    expect(leanToolList(other)).toBe(other)
  })
})
