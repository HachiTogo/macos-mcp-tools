// Everything the mail tools do that changes state: marking read, junk and flags, and sending,
// replying and forwarding. All of it goes through JXA, because the Envelope Index is opened
// readonly and Mail.app owns these operations.

import { spawnSync } from "node:child_process"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import {
  formatFlagEmailsSummary,
  formatForwardEmailSummary,
  formatMarkEmailsJunkSummary,
  formatMarkEmailsNotJunkSummary,
  formatMarkEmailsReadSummary,
  formatReplyEmailSummary,
  formatSendEmailSummary,
} from "./format"
import {
  FLAG_EMAILS_JXA,
  FORWARD_EMAIL_JXA,
  MARK_EMAILS_JUNK_JXA,
  MARK_EMAILS_NOT_JUNK_JXA,
  MARK_EMAILS_READ_JXA,
  REPLY_EMAIL_JXA,
  SEND_EMAIL_JXA,
} from "./jxa-scripts"
import type {
  FlagEmailsArguments,
  FlagEmailsResult,
  FlagEmailsTarget,
  ForwardEmailArguments,
  ForwardEmailResult,
  MarkEmailsJunkArguments,
  MarkEmailsJunkResult,
  MarkEmailsJunkTarget,
  MarkEmailsNotJunkArguments,
  MarkEmailsNotJunkResult,
  MarkEmailsNotJunkTarget,
  MarkEmailsReadArguments,
  MarkEmailsReadResult,
  MarkEmailsReadTarget,
  ReplyEmailArguments,
  ReplyEmailResult,
  SendEmailArguments,
  SendEmailResult,
} from "./types"

export const markEmailsReadWithJxa = (targets: MarkEmailsReadTarget[]) => {
  const command = spawnSync(
    "osascript",
    ["-l", "JavaScript", "-e", MARK_EMAILS_READ_JXA, "--", JSON.stringify({ targets })],
    {
      encoding: "utf8",
    },
  )

  if (command.error) {
    throw command.error
  }

  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `osascript failed with exit code ${command.status}.`)
  }

  const output = JSON.parse(command.stdout || "{}") as {
    results?: MarkEmailsReadResult[]
  }

  if (!Array.isArray(output.results)) {
    throw new Error("Mail mark read failed: invalid JXA response.")
  }

  return output.results
}

// Per-item statuses that mean nothing was changed for that email. A batch result is an error only when
// every item failed; partial success is reported through the per-item statuses instead.
export const FAILED_BATCH_STATUSES: ReadonlySet<string> = new Set([
  "not_found",
  "invalid_handle",
  "error",
  "no_junk_mailbox",
  "no_inbox_mailbox",
])

export const isBatchFailure = (results: ReadonlyArray<{ status: string }>) =>
  results.length > 0 && results.every((result) => FAILED_BATCH_STATUSES.has(result.status))

export const createMarkEmailsReadResult = async (argumentsValue: MarkEmailsReadArguments): Promise<CallToolResult> => {
  try {
    const results = markEmailsReadWithJxa(argumentsValue.emails)

    return {
      content: [
        {
          type: "text",
          text: formatMarkEmailsReadSummary(results),
        },
      ],
      structuredContent: {
        results,
      },
      ...(isBatchFailure(results) ? { isError: true } : {}),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const results: MarkEmailsReadResult[] = argumentsValue.emails.map((email) => ({
      id: email.id,
      subject: email.subject,
      handle: email.handle,
      status: "error",
      detail,
    }))

    return {
      content: [
        {
          type: "text",
          text: formatMarkEmailsReadSummary(results),
        },
      ],
      structuredContent: {
        results,
      },
      isError: true,
    }
  }
}

export const markEmailsJunkWithJxa = (targets: MarkEmailsJunkTarget[]) => {
  const command = spawnSync(
    "osascript",
    ["-l", "JavaScript", "-e", MARK_EMAILS_JUNK_JXA, "--", JSON.stringify({ targets })],
    {
      encoding: "utf8",
    },
  )

  if (command.error) {
    throw command.error
  }

  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `osascript failed with exit code ${command.status}.`)
  }

  const output = JSON.parse(command.stdout || "{}") as {
    results?: MarkEmailsJunkResult[]
  }

  if (!Array.isArray(output.results)) {
    throw new Error("Mail mark junk failed: invalid JXA response.")
  }

  return output.results
}

export const markEmailsNotJunkWithJxa = (targets: MarkEmailsNotJunkTarget[]) => {
  const command = spawnSync(
    "osascript",
    ["-l", "JavaScript", "-e", MARK_EMAILS_NOT_JUNK_JXA, "--", JSON.stringify({ targets })],
    {
      encoding: "utf8",
    },
  )

  if (command.error) {
    throw command.error
  }

  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `osascript failed with exit code ${command.status}.`)
  }

  const output = JSON.parse(command.stdout || "{}") as {
    results?: MarkEmailsNotJunkResult[]
  }

  if (!Array.isArray(output.results)) {
    throw new Error("Mail mark not-junk failed: invalid JXA response.")
  }

  return output.results
}

export const flagEmailsWithJxa = (targets: FlagEmailsTarget[]) => {
  const command = spawnSync(
    "osascript",
    ["-l", "JavaScript", "-e", FLAG_EMAILS_JXA, "--", JSON.stringify({ targets })],
    {
      encoding: "utf8",
    },
  )

  if (command.error) {
    throw command.error
  }

  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `osascript failed with exit code ${command.status}.`)
  }

  const output = JSON.parse(command.stdout || "{}") as {
    results?: FlagEmailsResult[]
  }

  if (!Array.isArray(output.results)) {
    throw new Error("Mail flag emails failed: invalid JXA response.")
  }

  return output.results
}

export const createMarkEmailsJunkResult = async (argumentsValue: MarkEmailsJunkArguments): Promise<CallToolResult> => {
  try {
    const results = markEmailsJunkWithJxa(argumentsValue.emails)

    return {
      content: [
        {
          type: "text",
          text: formatMarkEmailsJunkSummary(results),
        },
      ],
      structuredContent: {
        results,
      },
      ...(isBatchFailure(results) ? { isError: true } : {}),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const results: MarkEmailsJunkResult[] = argumentsValue.emails.map((email) => ({
      id: email.id,
      subject: email.subject,
      handle: email.handle,
      status: "error",
      detail,
    }))

    return {
      content: [
        {
          type: "text",
          text: formatMarkEmailsJunkSummary(results),
        },
      ],
      structuredContent: {
        results,
      },
      isError: true,
    }
  }
}

export const createMarkEmailsNotJunkResult = async (
  argumentsValue: MarkEmailsNotJunkArguments,
): Promise<CallToolResult> => {
  try {
    const results = markEmailsNotJunkWithJxa(argumentsValue.emails)

    return {
      content: [
        {
          type: "text",
          text: formatMarkEmailsNotJunkSummary(results),
        },
      ],
      structuredContent: {
        results,
      },
      ...(isBatchFailure(results) ? { isError: true } : {}),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const results: MarkEmailsNotJunkResult[] = argumentsValue.emails.map((email) => ({
      id: email.id,
      subject: email.subject,
      handle: email.handle,
      status: "error",
      detail,
    }))

    return {
      content: [
        {
          type: "text",
          text: formatMarkEmailsNotJunkSummary(results),
        },
      ],
      structuredContent: {
        results,
      },
      isError: true,
    }
  }
}

export const createFlagEmailsResult = async (argumentsValue: FlagEmailsArguments): Promise<CallToolResult> => {
  try {
    const results = flagEmailsWithJxa(argumentsValue.emails)

    return {
      content: [
        {
          type: "text",
          text: formatFlagEmailsSummary(results),
        },
      ],
      structuredContent: {
        results,
      },
      ...(isBatchFailure(results) ? { isError: true } : {}),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const results: FlagEmailsResult[] = argumentsValue.emails.map((email) => ({
      id: email.id,
      subject: email.subject,
      handle: email.handle,
      status: "error",
      detail,
    }))

    return {
      content: [
        {
          type: "text",
          text: formatFlagEmailsSummary(results),
        },
      ],
      structuredContent: {
        results,
      },
      isError: true,
    }
  }
}

export const sendEmailWithJxa = (args: SendEmailArguments): SendEmailResult => {
  const command = spawnSync("osascript", ["-l", "JavaScript", "-e", SEND_EMAIL_JXA, "--", JSON.stringify(args)], {
    encoding: "utf8",
  })

  if (command.error) {
    throw command.error
  }

  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `osascript failed with exit code ${command.status}.`)
  }

  const output = JSON.parse(command.stdout || "{}") as SendEmailResult
  if (output.status !== "sent" && output.status !== "error") {
    throw new Error("send_email: invalid JXA response.")
  }
  return output
}

export const replyEmailWithJxa = (args: ReplyEmailArguments): ReplyEmailResult => {
  const command = spawnSync("osascript", ["-l", "JavaScript", "-e", REPLY_EMAIL_JXA, "--", JSON.stringify(args)], {
    encoding: "utf8",
  })

  if (command.error) {
    throw command.error
  }

  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `osascript failed with exit code ${command.status}.`)
  }

  const output = JSON.parse(command.stdout || "{}") as ReplyEmailResult
  return output
}

export const forwardEmailWithJxa = (args: ForwardEmailArguments): ForwardEmailResult => {
  const command = spawnSync("osascript", ["-l", "JavaScript", "-e", FORWARD_EMAIL_JXA, "--", JSON.stringify(args)], {
    encoding: "utf8",
  })

  if (command.error) {
    throw command.error
  }

  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `osascript failed with exit code ${command.status}.`)
  }

  const output = JSON.parse(command.stdout || "{}") as ForwardEmailResult
  return output
}

export const createSendEmailResult = async (argumentsValue: SendEmailArguments): Promise<CallToolResult> => {
  try {
    const result = sendEmailWithJxa(argumentsValue)
    return {
      content: [
        {
          type: "text",
          text: formatSendEmailSummary(result),
        },
      ],
      structuredContent: result,
      ...(result.status === "error" ? { isError: true } : {}),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const result: SendEmailResult = { status: "error", detail }
    return {
      content: [{ type: "text", text: formatSendEmailSummary(result) }],
      structuredContent: result,
      isError: true,
    }
  }
}

export const createReplyEmailResult = async (argumentsValue: ReplyEmailArguments): Promise<CallToolResult> => {
  try {
    const result = replyEmailWithJxa(argumentsValue)
    return {
      content: [
        {
          type: "text",
          text: formatReplyEmailSummary(result),
        },
      ],
      structuredContent: result,
      ...(result.status !== "sent" ? { isError: true } : {}),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const result: ReplyEmailResult = { status: "error", detail }
    return {
      content: [{ type: "text", text: formatReplyEmailSummary(result) }],
      structuredContent: result,
      isError: true,
    }
  }
}

export const createForwardEmailResult = async (argumentsValue: ForwardEmailArguments): Promise<CallToolResult> => {
  try {
    const result = forwardEmailWithJxa(argumentsValue)
    return {
      content: [
        {
          type: "text",
          text: formatForwardEmailSummary(result),
        },
      ],
      structuredContent: result,
      ...(result.status !== "sent" ? { isError: true } : {}),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const result: ForwardEmailResult = { status: "error", detail }
    return {
      content: [{ type: "text", text: formatForwardEmailSummary(result) }],
      structuredContent: result,
      isError: true,
    }
  }
}
