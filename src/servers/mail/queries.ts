// Reading the Envelope Index. Apple ships different schemas across Mail versions, so the column
// sets are introspected at open time and every query is built against what the database actually
// has. Nothing here mutates: the two builders return SQL plus bound parameters for the caller to
// run against a readonly handle.

import type { Database, SQLQueryBindings } from "bun:sqlite"

import { EmailToolError } from "./errors"
import { toSearchBoundSeconds } from "./normalize"
import type { SchemaInfo, SearchEmailArguments, TableColumnRow } from "./types"

/**
 * The window of rows a single statement returns. Provider, mailbox and exclusion filters cannot be
 * expressed in this SQL -- they depend on the account config and on decoded mailbox names -- so the
 * caller pages through these windows until it has enough matches, rather than filtering one fixed
 * page and reporting whatever survived.
 */
export type QueryWindow = { limit: number; offset: number }

const DEFAULT_WINDOW: QueryWindow = { limit: 250, offset: 0 }

export const getColumns = (database: Database, tableName: string) => {
  try {
    const rows = database.query(`PRAGMA table_info(${tableName})`).all() as TableColumnRow[]
    return new Set(rows.map((row) => row.name))
  } catch {
    return new Set<string>()
  }
}

export const getSchemaInfo = (database: Database): SchemaInfo => ({
  messages: getColumns(database, "messages"),
  messageGlobalData: getColumns(database, "message_global_data"),
  subjects: getColumns(database, "subjects"),
  addresses: getColumns(database, "addresses"),
  senders: getColumns(database, "senders"),
  senderAddresses: getColumns(database, "sender_addresses"),
  mailboxes: getColumns(database, "mailboxes"),
})

export const ensureRequiredColumns = (schema: SchemaInfo) => {
  const requiredMessages = ["mailbox", "read", "deleted"]

  for (const column of requiredMessages) {
    if (!schema.messages.has(column)) {
      throw new EmailToolError(`Email read failed: missing messages.${column} in Envelope Index schema.`)
    }
  }

  if (!schema.mailboxes.has("url")) {
    throw new EmailToolError("Email read failed: missing mailboxes.url in Envelope Index schema.")
  }
}

/**
 * Everything both queries derive from the schema. Apple ships different Envelope Index shapes
 * across Mail versions, so which tables can be joined and how each column is expressed depends on
 * what is actually present -- and that reasoning is identical for both queries, which is why it
 * lives here rather than twice.
 */
const planQuery = (schema: SchemaInfo) => {
  const canResolveSubject = schema.messages.has("subject") && schema.subjects.has("subject")
  const canResolveDirectSender = schema.messages.has("sender") && schema.addresses.has("address")
  const canJoinSenderLookup = schema.messages.has("sender") && schema.senders.size > 0
  const canResolveMappedSender =
    canJoinSenderLookup &&
    schema.senderAddresses.has("sender") &&
    schema.senderAddresses.has("address") &&
    schema.addresses.has("address")

  const canJoinMessageGlobalData =
    schema.messages.has("message_id") &&
    schema.messageGlobalData.has("message_id") &&
    schema.messageGlobalData.has("message_id_header")

  const joins = ["JOIN mailboxes ON mailboxes.ROWID = messages.mailbox"]

  if (canResolveSubject) {
    joins.push("LEFT JOIN subjects subject_lookup ON subject_lookup.ROWID = messages.subject")
  }

  if (canResolveDirectSender) {
    joins.push("LEFT JOIN addresses direct_sender ON direct_sender.ROWID = messages.sender")
  }

  if (canJoinSenderLookup) {
    joins.push("LEFT JOIN senders sender_lookup ON sender_lookup.ROWID = messages.sender")
  }

  if (canResolveMappedSender) {
    joins.push(
      "LEFT JOIN (SELECT sender, MIN(address) AS address FROM sender_addresses GROUP BY sender) sender_address_lookup ON sender_address_lookup.sender = sender_lookup.ROWID",
    )
    joins.push("LEFT JOIN addresses mapped_sender ON mapped_sender.ROWID = sender_address_lookup.address")
  }

  if (canJoinMessageGlobalData) {
    joins.push("LEFT JOIN message_global_data mgd ON mgd.message_id = messages.message_id")
  }

  const receivedAtExpression = schema.messages.has("date_received")
    ? "messages.date_received"
    : schema.messages.has("display_date")
      ? "messages.display_date"
      : "NULL"

  const documentIdExpression = schema.messages.has("document_id") ? "messages.document_id" : "NULL"
  const messageIdExpression = schema.messages.has("message_id") ? "CAST(messages.message_id AS TEXT)" : "NULL"
  const messageIdHeaderExpression = canJoinMessageGlobalData ? "mgd.message_id_header" : "NULL"
  const subjectReferenceExpression = schema.messages.has("subject") ? "CAST(messages.subject AS TEXT)" : "NULL"
  const subjectPrefixExpression = schema.messages.has("subject_prefix") ? "messages.subject_prefix" : "NULL"
  const senderReferenceExpression = schema.messages.has("sender") ? "CAST(messages.sender AS TEXT)" : "NULL"
  const resolvedSubjectExpression = canResolveSubject ? "subject_lookup.subject" : "NULL"

  const resolvedSenderNameParts = [
    canResolveDirectSender ? "NULLIF(TRIM(direct_sender.comment), '')" : undefined,
    canResolveMappedSender ? "NULLIF(TRIM(mapped_sender.comment), '')" : undefined,
    canJoinSenderLookup && schema.senders.has("contact_identifier")
      ? "NULLIF(TRIM(sender_lookup.contact_identifier), '')"
      : undefined,
  ].filter(Boolean)

  const resolvedSenderAddressParts = [
    canResolveDirectSender ? "NULLIF(TRIM(direct_sender.address), '')" : undefined,
    canResolveMappedSender ? "NULLIF(TRIM(mapped_sender.address), '')" : undefined,
  ].filter(Boolean)

  const resolvedSenderNameExpression =
    resolvedSenderNameParts.length > 0 ? `COALESCE(${resolvedSenderNameParts.join(", ")})` : "NULL"

  const resolvedSenderAddressExpression =
    resolvedSenderAddressParts.length > 0 ? `COALESCE(${resolvedSenderAddressParts.join(", ")})` : "NULL"

  // The columns both queries select, in the order NormalizedEmail reads them.
  const columns = [
    "CAST(messages.ROWID AS TEXT) AS rowIdText",
    `${messageIdExpression} AS messageIdText`,
    `${documentIdExpression} AS documentId`,
    `${receivedAtExpression} AS receivedAtUnix`,
    `${resolvedSubjectExpression} AS resolvedSubject`,
    `${subjectReferenceExpression} AS subjectReferenceText`,
    `${subjectPrefixExpression} AS subjectPrefix`,
    `${resolvedSenderNameExpression} AS resolvedSenderName`,
    `${resolvedSenderAddressExpression} AS resolvedSenderAddress`,
    `${senderReferenceExpression} AS senderReferenceText`,
    "mailboxes.url AS mailboxUrl",
  ]

  return {
    canResolveSubject,
    canResolveDirectSender,
    canResolveMappedSender,
    columns,
    joins,
    messageIdHeaderExpression,
    receivedAtExpression,
  }
}

/** Assembles the statement once both queries have decided what to select and what to filter on. */
const composeQuery = (
  plan: ReturnType<typeof planQuery>,
  columns: string[],
  whereClauses: string[],
  page: QueryWindow,
) => `
    SELECT
      ${columns.join(",\n      ")}
    FROM messages
    ${plan.joins.join("\n    ")}
    WHERE ${whereClauses.join("\n      AND ")}
    ORDER BY COALESCE(${plan.receivedAtExpression}, 0) DESC, messages.ROWID DESC
    LIMIT ${page.limit} OFFSET ${page.offset}
  `

/** Mailboxes that hold drafts and local-only mail are never a source of unread mail worth reading. */
const BASE_WHERE = ["messages.deleted = 0", "mailboxes.url IS NOT NULL", "mailboxes.url NOT LIKE 'local://%'"]

/**
 * Every mailbox the Envelope Index knows about, with its unread count. This is what backs
 * `list_mail_accounts`: the other tools take a `mailbox` substring and a `provider`, and without
 * this an agent has to guess both and read an empty result as "nothing matched".
 */
export const buildMailboxInventoryQuery = () => `
    SELECT
      mailboxes.url AS mailboxUrl,
      SUM(CASE WHEN messages.read = 0 AND messages.deleted = 0 THEN 1 ELSE 0 END) AS unreadCount
    FROM mailboxes
    LEFT JOIN messages ON messages.mailbox = mailboxes.ROWID
    WHERE mailboxes.url IS NOT NULL
      AND mailboxes.url NOT LIKE 'local://%'
    GROUP BY mailboxes.url
    ORDER BY mailboxes.url
  `

export const buildUnreadMessagesQuery = (schema: SchemaInfo, page: QueryWindow = DEFAULT_WINDOW) => {
  const plan = planQuery(schema)
  return composeQuery(
    plan,
    [...plan.columns, `${plan.messageIdHeaderExpression} AS messageIdHeader`],
    ["messages.read = 0", ...BASE_WHERE],
    page,
  )
}

export const buildSearchMessagesQuery = (
  schema: SchemaInfo,
  args: SearchEmailArguments,
  page: QueryWindow = DEFAULT_WINDOW,
): { sql: string; params: SQLQueryBindings[] } => {
  const plan = planQuery(schema)
  const params: SQLQueryBindings[] = []
  const whereClauses = [...BASE_WHERE]

  if (args.unreadOnly) {
    whereClauses.push("messages.read = 0")
  }

  if (args.subject) {
    const subjectParts: string[] = []
    if (plan.canResolveSubject) {
      subjectParts.push("COALESCE(subject_lookup.subject, '') LIKE ?")
      params.push(`%${args.subject}%`)
    }
    if (schema.messages.has("subject_prefix")) {
      subjectParts.push("COALESCE(messages.subject_prefix, '') LIKE ?")
      params.push(`%${args.subject}%`)
    }
    if (subjectParts.length > 0) {
      whereClauses.push(`(${subjectParts.join(" OR ")})`)
    }
  }

  if (args.sender) {
    const senderParts: string[] = []
    if (plan.canResolveDirectSender) {
      senderParts.push("COALESCE(direct_sender.address, '') LIKE ?")
      params.push(`%${args.sender}%`)
      senderParts.push("COALESCE(direct_sender.comment, '') LIKE ?")
      params.push(`%${args.sender}%`)
    }
    if (plan.canResolveMappedSender) {
      senderParts.push("COALESCE(mapped_sender.address, '') LIKE ?")
      params.push(`%${args.sender}%`)
      senderParts.push("COALESCE(mapped_sender.comment, '') LIKE ?")
      params.push(`%${args.sender}%`)
    }
    if (senderParts.length > 0) {
      whereClauses.push(`(${senderParts.join(" OR ")})`)
    }
  }

  if (args.after) {
    whereClauses.push(`COALESCE(${plan.receivedAtExpression}, 0) >= ?`)
    params.push(toSearchBoundSeconds(args.after))
  }

  if (args.before) {
    whereClauses.push(`COALESCE(${plan.receivedAtExpression}, 0) < ?`)
    params.push(toSearchBoundSeconds(args.before))
  }

  const columns = [...plan.columns, "messages.read AS readFlag", `${plan.messageIdHeaderExpression} AS messageIdHeader`]

  return { sql: composeQuery(plan, columns, whereClauses, page), params }
}
