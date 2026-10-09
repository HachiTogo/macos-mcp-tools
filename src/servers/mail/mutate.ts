// Everything the mail tools do that changes state: marking read, junk and flags, and sending,
// replying and forwarding. All of it goes through JXA, because the Envelope Index is opened
// readonly and Mail.app owns these operations.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import { JXA_TIMEOUT_MS, runJxa } from "../../lib/jxa"
import { errorMessage } from "../../lib/mcp-result"

import {
  formatFlagEmailsSummary,
  formatForwardEmailSummary,
  formatMarkEmailsJunkSummary,
  formatMarkEmailsNotJunkSummary,
  formatMarkEmailsReadSummary,
  formatReplyEmailSummary,
  formatSendEmailSummary,
} from "./format"
import { FORWARD_EMAIL_JXA, REPLY_EMAIL_JXA, SEND_EMAIL_JXA } from "./jxa-compose"
import { FLAG_EMAILS_JXA, MARK_EMAILS_JUNK_JXA, MARK_EMAILS_NOT_JUNK_JXA, MARK_EMAILS_READ_JXA } from "./jxa-scripts"
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

// The mark and flag tools handle a whole batch in one osascript call, at about 0.14 s a message (100
// took 13.5 s). The runner's default timeout would cut off batches of a few hundred that complete
// today, so a batch gets a second per message on top of it.
const batchTimeoutMs = (count: number) => JXA_TIMEOUT_MS + count * 1_000

export const markEmailsReadWithJxa = (targets: MarkEmailsReadTarget[]) => {
  const stdout = runJxa(MARK_EMAILS_READ_JXA, { targets }, { timeoutMs: batchTimeoutMs(targets.length) })

  const output = JSON.parse(stdout || "{}") as {
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
    const detail = errorMessage(error)
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
  const stdout = runJxa(MARK_EMAILS_JUNK_JXA, { targets }, { timeoutMs: batchTimeoutMs(targets.length) })

  const output = JSON.parse(stdout || "{}") as {
    results?: MarkEmailsJunkResult[]
  }

  if (!Array.isArray(output.results)) {
    throw new Error("Mail mark junk failed: invalid JXA response.")
  }

  return output.results
}

export const markEmailsNotJunkWithJxa = (targets: MarkEmailsNotJunkTarget[]) => {
  const stdout = runJxa(MARK_EMAILS_NOT_JUNK_JXA, { targets }, { timeoutMs: batchTimeoutMs(targets.length) })

  const output = JSON.parse(stdout || "{}") as {
    results?: MarkEmailsNotJunkResult[]
  }

  if (!Array.isArray(output.results)) {
    throw new Error("Mail mark not-junk failed: invalid JXA response.")
  }

  return output.results
}

export const flagEmailsWithJxa = (targets: FlagEmailsTarget[]) => {
  const stdout = runJxa(FLAG_EMAILS_JXA, { targets }, { timeoutMs: batchTimeoutMs(targets.length) })

  const output = JSON.parse(stdout || "{}") as {
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
    const detail = errorMessage(error)
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
    const detail = errorMessage(error)
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
    const detail = errorMessage(error)
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
  const stdout = runJxa(SEND_EMAIL_JXA, { ...args })

  const output = JSON.parse(stdout || "{}") as SendEmailResult
  if (output.status !== "sent" && output.status !== "error") {
    throw new Error("send_email: invalid JXA response.")
  }
  return output
}

export const replyEmailWithJxa = (args: ReplyEmailArguments): ReplyEmailResult => {
  const stdout = runJxa(REPLY_EMAIL_JXA, { ...args })

  const output = JSON.parse(stdout || "{}") as ReplyEmailResult
  return output
}

export const forwardEmailWithJxa = (args: ForwardEmailArguments): ForwardEmailResult => {
  const stdout = runJxa(FORWARD_EMAIL_JXA, { ...args })

  const output = JSON.parse(stdout || "{}") as ForwardEmailResult
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
    const detail = errorMessage(error)
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
    const detail = errorMessage(error)
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
    const detail = errorMessage(error)
    const result: ForwardEmailResult = { status: "error", detail }
    return {
      content: [{ type: "text", text: formatForwardEmailSummary(result) }],
      structuredContent: result,
      isError: true,
    }
  }
}
