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

describe("leanSchema type lists", () => {
  test("spells a nullable anyOf of bare types as a type list, and leaves richer options alone", () => {
    const nullable = { anyOf: [{ type: "string" }, { type: "null" }], description: "d" }
    expect(leanSchema(nullable)).toEqual({ type: ["string", "null"], description: "d" })
    const rich = { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] }
    expect(leanSchema(rich)).toEqual(rich)
  })
})

describe("leanToolList", () => {
  test("drops execution only when it says the default, taskSupport forbidden", () => {
    const listed = (execution: object) =>
      ({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "t", execution }] } }) as JSONRPCMessage
    const tools = (message: JSONRPCMessage) => (message as unknown as { result: { tools: object[] } }).result.tools
    expect(tools(leanToolList(listed({ taskSupport: "forbidden" })))).toEqual([{ name: "t" }])
    expect(tools(leanToolList(listed({ taskSupport: "optional" })))).toEqual([
      { name: "t", execution: { taskSupport: "optional" } },
    ])
  })

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
