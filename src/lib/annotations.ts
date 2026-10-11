import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"

// Every tool sets all four MCP hints from one of these, so a host can tell reads from writes and ask
// before anything destructive. Destructive means the call can lose something: a delete, an update that
// overwrites, junking mail, or a message that cannot be unsent.

const hints = (readOnly: boolean, destructive: boolean, idempotent: boolean, openWorld: boolean): ToolAnnotations => ({
  readOnlyHint: readOnly,
  destructiveHint: destructive,
  idempotentHint: idempotent,
  openWorldHint: openWorld,
})

/** Reads change nothing. */
export const READ = hints(true, false, true, false)

/** Creates and appends add something new; a repeat adds it again, but nothing is lost. */
export const CREATE = hints(false, false, false, false)

/** Marking, flagging, moving or grouping keeps everything; a repeat changes nothing more. */
export const SET = hints(false, false, true, false)

/** Deletes, overwriting updates and junking can lose something; a repeat changes nothing more. */
export const DESTRUCTIVE = hints(false, true, true, false)

/** Sending reaches other people and cannot be taken back; each call sends again. */
export const SEND = hints(false, true, false, true)
