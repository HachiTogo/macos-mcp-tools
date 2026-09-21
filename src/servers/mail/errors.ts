// The one error type the mail read path raises itself, as opposed to errors surfacing from
// sqlite or osascript. It exists so callers can tell "this Envelope Index is not shaped the way
// we need" apart from a genuine failure, and report it with a usable message.

export class EmailToolError extends Error {
  code: "read_failed"

  constructor(message: string) {
    super(message)
    this.name = "EmailToolError"
    this.code = "read_failed"
  }
}
