// Human-readable text for every mail tool result. These build the `text` half of a response; the
// structured half is the same data unformatted. Batch mutations summarize per-item statuses here,
// which is why each one walks its results rather than printing a count.

import type {
  EmailConfig,
  EmailGroup,
  FlagEmailsResult,
  ForwardEmailResult,
  MarkEmailsJunkResult,
  MarkEmailsNotJunkResult,
  MarkEmailsReadResult,
  NormalizedEmail,
  ReplyEmailResult,
  SearchEmailArguments,
  SendEmailResult,
  UnreadEmailArguments,
} from "./types"

export const formatEmailLine = (email: NormalizedEmail, index: number) => {
  const sender = email.senderName || email.senderAddress || "Unknown sender"
  const mailbox = email.mailboxName || email.mailboxUrl
  const receivedAt = email.receivedAtLocal || email.receivedAt || "unknown time"
  return `${index + 1}. [${receivedAt}] ${sender} — ${email.subject} (${mailbox})`
}

export const groupEmailsByAccount = (emails: NormalizedEmail[], config: EmailConfig) => {
  const groups = new Map<string, EmailGroup>()

  for (const email of emails) {
    const key = `${email.accountLabel}:${email.accountCategory}`
    const existing = groups.get(key)

    if (existing) {
      existing.messages.push(email)
      continue
    }

    groups.set(key, {
      accountLabel: email.accountLabel,
      accountCategory: email.accountCategory,
      messages: [email],
    })
  }

  const order = config.displayOrder
  // Labels missing from displayOrder sort after configured ones, alphabetically. A finite sentinel
  // avoids Infinity - Infinity = NaN, which made the sort unspecified whenever displayOrder was empty.
  const rank = (label: string) => {
    const index = order.indexOf(label)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }
  return [...groups.values()].sort(
    (left, right) =>
      rank(left.accountLabel) - rank(right.accountLabel) || left.accountLabel.localeCompare(right.accountLabel),
  )
}

export const formatEmailsForContent = (
  emails: NormalizedEmail[],
  argumentsValue: UnreadEmailArguments,
  config: EmailConfig,
) => {
  const summaryParts = [`Found ${emails.length} unread email${emails.length === 1 ? "" : "s"}`]

  if (argumentsValue.provider) {
    summaryParts.push(`for ${argumentsValue.provider}`)
  }

  if (argumentsValue.mailbox) {
    summaryParts.push(`matching mailbox "${argumentsValue.mailbox}"`)
  }

  const groupedSections = groupEmailsByAccount(emails, config).map((group) => {
    const heading = `${group.accountLabel} (${group.accountCategory}) — ${group.messages.length} unread`
    const lines = group.messages.map(formatEmailLine)
    return `${heading}\n${lines.join("\n")}`
  })
  const json = JSON.stringify(emails, null, 2)

  if (groupedSections.length === 0) {
    return `${summaryParts.join(" ")}.\n\n[]`
  }

  return `${summaryParts.join(" ")}.\n\n${groupedSections.join("\n\n")}\n\n${json}`
}

export const formatSendEmailSummary = (result: SendEmailResult) => {
  if (result.status === "sent") {
    if (typeof result.recipientCount === "number") {
      return `Sent: ${result.recipientCount} recipient${result.recipientCount === 1 ? "" : "s"}.`
    }
    return "Sent."
  }
  return `send_email failed: ${result.detail ?? "unknown error"}`
}

export const formatReplyEmailSummary = (result: ReplyEmailResult) => {
  switch (result.status) {
    case "sent":
      return "Reply sent."
    case "not_found":
      return `reply_email failed: ${result.detail ?? "Original message not found."}`
    case "invalid_handle":
      return `reply_email failed: ${result.detail ?? "Invalid handle."}`
    default:
      return `reply_email failed: ${result.detail ?? "unknown error"}`
  }
}

export const formatForwardEmailSummary = (result: ForwardEmailResult) => {
  switch (result.status) {
    case "sent":
      if (typeof result.recipientCount === "number") {
        return `Forward sent: ${result.recipientCount} recipient${result.recipientCount === 1 ? "" : "s"}.`
      }
      return "Forward sent."
    case "not_found":
      return `forward_email failed: ${result.detail ?? "Original message not found."}`
    case "invalid_handle":
      return `forward_email failed: ${result.detail ?? "Invalid handle."}`
    default:
      return `forward_email failed: ${result.detail ?? "unknown error"}`
  }
}

export const formatMarkEmailsReadSummary = (results: MarkEmailsReadResult[]) => {
  const counts = {
    markedRead: 0,
    alreadyRead: 0,
    notFound: 0,
    invalidHandle: 0,
    error: 0,
  }

  for (const result of results) {
    switch (result.status) {
      case "marked_read":
        counts.markedRead += 1
        break
      case "already_read":
        counts.alreadyRead += 1
        break
      case "not_found":
        counts.notFound += 1
        break
      case "invalid_handle":
        counts.invalidHandle += 1
        break
      case "error":
        counts.error += 1
        break
    }
  }

  const parts = [`Processed ${results.length} email${results.length === 1 ? "" : "s"}`]

  if (counts.markedRead > 0) {
    parts.push(`${counts.markedRead} marked read`)
  }

  if (counts.alreadyRead > 0) {
    parts.push(`${counts.alreadyRead} already read`)
  }

  if (counts.notFound > 0) {
    parts.push(`${counts.notFound} not found`)
  }

  if (counts.invalidHandle > 0) {
    parts.push(`${counts.invalidHandle} invalid handle`)
  }

  if (counts.error > 0) {
    parts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`)
  }

  return `${parts.join("; ")}.`
}

export const formatMarkEmailsJunkSummary = (results: MarkEmailsJunkResult[]) => {
  const counts = {
    markedJunk: 0,
    alreadyJunk: 0,
    notFound: 0,
    invalidHandle: 0,
    noJunkMailbox: 0,
    error: 0,
  }

  for (const result of results) {
    switch (result.status) {
      case "marked_junk":
        counts.markedJunk += 1
        break
      case "already_junk":
        counts.alreadyJunk += 1
        break
      case "not_found":
        counts.notFound += 1
        break
      case "invalid_handle":
        counts.invalidHandle += 1
        break
      case "no_junk_mailbox":
        counts.noJunkMailbox += 1
        break
      case "error":
        counts.error += 1
        break
    }
  }

  const parts = [`Processed ${results.length} email${results.length === 1 ? "" : "s"}`]

  if (counts.markedJunk > 0) {
    parts.push(`${counts.markedJunk} marked junk`)
  }

  if (counts.alreadyJunk > 0) {
    parts.push(`${counts.alreadyJunk} already junk`)
  }

  if (counts.notFound > 0) {
    parts.push(`${counts.notFound} not found`)
  }

  if (counts.invalidHandle > 0) {
    parts.push(`${counts.invalidHandle} invalid handle`)
  }

  if (counts.noJunkMailbox > 0) {
    parts.push(`${counts.noJunkMailbox} no junk mailbox`)
  }

  if (counts.error > 0) {
    parts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`)
  }

  return `${parts.join("; ")}.`
}

export const formatMarkEmailsNotJunkSummary = (results: MarkEmailsNotJunkResult[]) => {
  const counts = {
    markedNotJunk: 0,
    alreadyNotJunk: 0,
    notFound: 0,
    invalidHandle: 0,
    noInboxMailbox: 0,
    error: 0,
  }

  for (const result of results) {
    switch (result.status) {
      case "marked_not_junk":
        counts.markedNotJunk += 1
        break
      case "already_not_junk":
        counts.alreadyNotJunk += 1
        break
      case "not_found":
        counts.notFound += 1
        break
      case "invalid_handle":
        counts.invalidHandle += 1
        break
      case "no_inbox_mailbox":
        counts.noInboxMailbox += 1
        break
      case "error":
        counts.error += 1
        break
    }
  }

  const parts = [`Processed ${results.length} email${results.length === 1 ? "" : "s"}`]

  if (counts.markedNotJunk > 0) {
    parts.push(`${counts.markedNotJunk} marked not junk`)
  }

  if (counts.alreadyNotJunk > 0) {
    parts.push(`${counts.alreadyNotJunk} already not junk`)
  }

  if (counts.notFound > 0) {
    parts.push(`${counts.notFound} not found`)
  }

  if (counts.invalidHandle > 0) {
    parts.push(`${counts.invalidHandle} invalid handle`)
  }

  if (counts.noInboxMailbox > 0) {
    parts.push(`${counts.noInboxMailbox} no inbox mailbox`)
  }

  if (counts.error > 0) {
    parts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`)
  }

  return `${parts.join("; ")}.`
}

export const formatFlagEmailsSummary = (results: FlagEmailsResult[]) => {
  const counts = {
    flagged: 0,
    notFound: 0,
    invalidHandle: 0,
    error: 0,
  }

  for (const result of results) {
    switch (result.status) {
      case "flagged":
        counts.flagged += 1
        break
      case "not_found":
        counts.notFound += 1
        break
      case "invalid_handle":
        counts.invalidHandle += 1
        break
      case "error":
        counts.error += 1
        break
    }
  }

  const parts = [`Processed ${results.length} email${results.length === 1 ? "" : "s"}`]

  if (counts.flagged > 0) {
    parts.push(`${counts.flagged} flagged`)
  }

  if (counts.notFound > 0) {
    parts.push(`${counts.notFound} not found`)
  }

  if (counts.invalidHandle > 0) {
    parts.push(`${counts.invalidHandle} invalid handle`)
  }

  if (counts.error > 0) {
    parts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`)
  }

  return `${parts.join("; ")}.`
}

export const formatSearchEmailSummary = (emails: NormalizedEmail[], args: SearchEmailArguments): string => {
  const criteria: string[] = []
  if (args.subject) criteria.push(`subject contains "${args.subject}"`)
  if (args.sender) criteria.push(`sender contains "${args.sender}"`)
  if (args.after) criteria.push(`after ${args.after}`)
  if (args.before) criteria.push(`before ${args.before}`)
  if (args.mailbox) criteria.push(`mailbox "${args.mailbox}"`)
  if (args.provider) criteria.push(`provider: ${args.provider}`)
  if (args.unreadOnly) criteria.push("unread only")

  const header = `Found ${emails.length} email(s) matching: ${criteria.join(", ")}`

  if (emails.length === 0) return header

  const lines = emails.map((e, i) => {
    const date = e.receivedAtLocal || e.receivedAt || "unknown date"
    const read = e.isUnread ? "unread" : "read"
    return `${i + 1}. [${date}] [${read}] ${e.senderName || e.senderAddress || "unknown"}: ${e.subject || "(no subject)"}`
  })

  return `${header}\n\n${lines.join("\n")}`
}
