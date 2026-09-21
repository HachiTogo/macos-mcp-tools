// Reading the Envelope Index. Apple ships different schemas across Mail versions, so the column
// sets are introspected at open time and every query is built against what the database actually
// has. Nothing here mutates: the two builders return SQL plus bound parameters for the caller to
// run against a readonly handle.

import type { Database, SQLQueryBindings } from "bun:sqlite"

import { EmailToolError } from "./errors"
import type { SchemaInfo, SearchEmailArguments, TableColumnRow } from "./types"

// Rows are capped in SQL and filtered in JS afterwards; see the callers in mail.ts.
const READ_FETCH_LIMIT = 250

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

export const buildUnreadMessagesQuery = (schema: SchemaInfo) => {
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

  return `
    SELECT
      CAST(messages.ROWID AS TEXT) AS rowIdText,
      ${messageIdExpression} AS messageIdText,
      ${documentIdExpression} AS documentId,
      ${receivedAtExpression} AS receivedAtUnix,
      ${resolvedSubjectExpression} AS resolvedSubject,
      ${subjectReferenceExpression} AS subjectReferenceText,
      ${subjectPrefixExpression} AS subjectPrefix,
      ${resolvedSenderNameExpression} AS resolvedSenderName,
      ${resolvedSenderAddressExpression} AS resolvedSenderAddress,
      ${senderReferenceExpression} AS senderReferenceText,
      mailboxes.url AS mailboxUrl,
      ${messageIdHeaderExpression} AS messageIdHeader
    FROM messages
    ${joins.join("\n    ")}
    WHERE messages.read = 0
      AND messages.deleted = 0
      AND mailboxes.url IS NOT NULL
      AND mailboxes.url NOT LIKE 'local://%'
    ORDER BY COALESCE(${receivedAtExpression}, 0) DESC, messages.ROWID DESC
    LIMIT ${READ_FETCH_LIMIT}
  `
}

export const buildSearchMessagesQuery = (
  schema: SchemaInfo,
  args: SearchEmailArguments,
): { sql: string; params: SQLQueryBindings[] } => {
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

  const params: SQLQueryBindings[] = []
  const whereClauses: string[] = [
    "messages.deleted = 0",
    "mailboxes.url IS NOT NULL",
    "mailboxes.url NOT LIKE 'local://%'",
  ]

  if (args.unreadOnly) {
    whereClauses.push("messages.read = 0")
  }

  if (args.subject) {
    const subjectParts: string[] = []
    if (canResolveSubject) {
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
    if (canResolveDirectSender) {
      senderParts.push("COALESCE(direct_sender.address, '') LIKE ?")
      params.push(`%${args.sender}%`)
      senderParts.push("COALESCE(direct_sender.comment, '') LIKE ?")
      params.push(`%${args.sender}%`)
    }
    if (canResolveMappedSender) {
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
    whereClauses.push(`COALESCE(${receivedAtExpression}, 0) >= ?`)
    params.push(Math.floor(new Date(args.after).getTime() / 1000))
  }

  if (args.before) {
    whereClauses.push(`COALESCE(${receivedAtExpression}, 0) < ?`)
    params.push(Math.floor(new Date(args.before).getTime() / 1000))
  }

  const sql = `
    SELECT
      CAST(messages.ROWID AS TEXT) AS rowIdText,
      ${messageIdExpression} AS messageIdText,
      ${documentIdExpression} AS documentId,
      ${receivedAtExpression} AS receivedAtUnix,
      ${resolvedSubjectExpression} AS resolvedSubject,
      ${subjectReferenceExpression} AS subjectReferenceText,
      ${subjectPrefixExpression} AS subjectPrefix,
      ${resolvedSenderNameExpression} AS resolvedSenderName,
      ${resolvedSenderAddressExpression} AS resolvedSenderAddress,
      ${senderReferenceExpression} AS senderReferenceText,
      mailboxes.url AS mailboxUrl,
      messages.read AS readFlag,
      ${messageIdHeaderExpression} AS messageIdHeader
    FROM messages
    ${joins.join("\n    ")}
    WHERE ${whereClauses.join("\n      AND ")}
    ORDER BY COALESCE(${receivedAtExpression}, 0) DESC, messages.ROWID DESC
    LIMIT ${READ_FETCH_LIMIT}
  `

  return { sql, params }
}
