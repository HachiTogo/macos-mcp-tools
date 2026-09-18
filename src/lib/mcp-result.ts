import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

/**
 * Shared tool-result contract for every server in this package.
 *
 * - `content[0].text` is for humans: a rendering chosen by the tool (prose, markdown), or pretty
 *   JSON when no better rendering exists.
 * - `structuredContent` carries the machine-readable payload verbatim. Arrays are wrapped as
 *   `{ result }` because the MCP schema requires an object.
 * - Failures return `isError: true` with text `"<operation> failed: <message>"`, never a thrown
 *   error, so validation and runtime failures reach the agent as tool results rather than
 *   JSON-RPC protocol errors.
 */

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const textResult = (text: string, structuredContent?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text }],
  ...(structuredContent ? { structuredContent } : {}),
})

export const jsonResult = (payload: unknown): CallToolResult =>
  textResult(JSON.stringify(payload, null, 2), isPlainObject(payload) ? payload : { result: payload })

export const errorResult = (operation: string, error: unknown): CallToolResult => ({
  content: [{ type: "text", text: `${operation} failed: ${errorMessage(error)}` }],
  isError: true,
})

/** Runs a tool body and converts any throw into an `errorResult` for `operation`. */
export const runTool = async (
  operation: string,
  body: () => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> => {
  try {
    return await body()
  } catch (error) {
    return errorResult(operation, error)
  }
}
