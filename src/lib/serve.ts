import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"

// Every host loads tools/list into the model's context. The SDK's JSON Schema carries boilerplate
// no client needs: `$schema` on every schema, `additionalProperties: false` on inputs (the server
// strips unknown keys anyway) or `{}` on loose outputs, the ±2^53 bounds zod adds to every integer,
// `anyOf` spelled out where a list of types says the same, and `execution: { taskSupport:
// "forbidden" }`, which is what a tool without `execution` means. Dropping it changes nothing a tool
// accepts or returns.

const isBoilerplate = (key: string, value: unknown) =>
  key === "$schema" ||
  (key === "additionalProperties" &&
    (value === false || (typeof value === "object" && value !== null && Object.keys(value).length === 0))) ||
  ((key === "maximum" || key === "minimum") && Math.abs(value as number) === Number.MAX_SAFE_INTEGER)

/** `anyOf: [{ type: "string" }, { type: "null" }]` as `["string", "null"]`; undefined if not that simple. */
const typeList = (anyOf: unknown): string[] | undefined => {
  if (!Array.isArray(anyOf)) return undefined
  const types = anyOf.map((option) =>
    typeof option === "object" && option !== null && Object.keys(option).length === 1 ? option.type : undefined,
  )
  return types.every((type) => typeof type === "string") ? types : undefined
}

/** A JSON Schema without the boilerplate. Property names are never treated as keywords. */
export const leanSchema = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(leanSchema)
  if (typeof schema !== "object" || schema === null) return schema
  const lean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (isBoilerplate(key, value)) continue
    const types = key === "anyOf" && !("type" in schema) ? typeList(value) : undefined
    if (types) {
      lean.type = types
      continue
    }
    lean[key] =
      key === "properties" && typeof value === "object" && value !== null
        ? Object.fromEntries(Object.entries(value).map(([name, field]) => [name, leanSchema(field)]))
        : leanSchema(value)
  }
  return lean
}

type ListedTool = { inputSchema?: unknown; outputSchema?: unknown; execution?: { taskSupport?: string } }

const isDefaultExecution = (execution: ListedTool["execution"]) =>
  execution !== undefined && Object.keys(execution).length === 1 && execution.taskSupport === "forbidden"

/** A tools/list response with lean schemas; every other message passes through untouched. */
export const leanToolList = (message: JSONRPCMessage): JSONRPCMessage => {
  const result = "result" in message ? (message.result as { tools?: unknown }) : undefined
  if (!result || !Array.isArray(result.tools)) return message
  const tools = (result.tools as ListedTool[]).map(({ execution, ...tool }) => ({
    ...tool,
    ...(tool.inputSchema ? { inputSchema: leanSchema(tool.inputSchema) } : {}),
    ...(tool.outputSchema ? { outputSchema: leanSchema(tool.outputSchema) } : {}),
    ...(isDefaultExecution(execution) ? {} : execution ? { execution } : {}),
  }))
  return { ...message, result: { ...result, tools } } as JSONRPCMessage
}

/** Serves an MCP server over stdio, listing its tools with lean schemas. */
export const serve = async (server: McpServer) => {
  const transport = new StdioServerTransport()
  const send = transport.send.bind(transport)
  transport.send = (message: JSONRPCMessage) => send(leanToolList(message))
  await server.connect(transport)
}
