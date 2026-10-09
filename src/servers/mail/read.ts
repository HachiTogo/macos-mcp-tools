// The mail tools that read the Envelope Index: unread mail, search, and the account and mailbox
// inventory. Message bodies, links and attachments are in message-content.ts.

import { Database } from "bun:sqlite"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import { errorMessage } from "../../lib/mcp-result"

import { discoverAndWriteConfig, loadEmailConfig, resolveConfigPath } from "./config"
import { MAIL_DB_PATH, TIME_ZONE } from "./constants"
import { EmailToolError } from "./errors"
import { formatEmailsForContent, formatSearchEmailSummary } from "./format"
import { getMailboxAccountKey, getMailboxName, getProviderByAccount } from "./mailbox"
import { cleanText, matchesMailboxFilter, normalizeEmail, SOURCE_NAME } from "./normalize"
import {
  buildMailboxInventoryQuery,
  buildSearchMessagesQuery,
  buildUnreadMessagesQuery,
  ensureRequiredColumns,
  getSchemaInfo,
  type QueryWindow,
} from "./queries"
import type {
  EmailConfig,
  EmailRow,
  ListMailAccountsResult,
  MailAccountSummary,
  SearchEmailArguments,
  UnreadEmailArguments,
} from "./types"

/**
 * The account config for a read. A file that exists but does not parse is reported, never
 * replaced: discovery writes defaults, and overwriting a hand-edited file with them loses work
 * the user cannot get back.
 */
const resolveConfigForRead = (database: Database): { config: EmailConfig; warnings: string[] } => {
  const path = resolveConfigPath()
  const loaded = loadEmailConfig()

  if (loaded.status === "invalid") {
    throw new EmailToolError(
      `Email account config at ${path} could not be read: ${loaded.reason}. Fix or delete that file; it will not be overwritten.`,
    )
  }

  if (loaded.status === "ok" && Object.keys(loaded.config.accounts).length > 0) {
    return { config: loaded.config, warnings: [] }
  }

  const discovered = discoverAndWriteConfig(database, path)
  return {
    config: discovered.config,
    warnings: discovered.writeError
      ? [
          `⚠️ Could not save the account config to ${path}: ${discovered.writeError}. Accounts are rediscovered on every call until this is fixed.`,
        ]
      : [],
  }
}

/** Rows a single statement returns while looking for matches. */
const SCAN_PAGE = 250
/** Ceiling on rows examined for one call, so a narrow filter over a huge mailbox still terminates. */
const MAX_SCAN = 5_000

type Scan<T> = { matches: T[]; scanned: number; exhausted: boolean }

/**
 * Pages through a query until enough rows survive filtering.
 *
 * Provider, mailbox and exclusion filters depend on the account config and on decoded mailbox
 * names, so none of them can be pushed into the SQL. Reading one fixed page and filtering it --
 * what this used to do -- means a filter matching nothing among the newest 250 messages reports no
 * results at all, however many actually match.
 */
const scanForMatches = <Row, Match>(
  fetchPage: (page: QueryWindow) => Row[],
  keep: (row: Row) => Match | undefined,
  need: number,
): Scan<Match> => {
  const matches: Match[] = []
  let scanned = 0
  let exhausted = false

  while (matches.length < need && scanned < MAX_SCAN) {
    const rows = fetchPage({ limit: SCAN_PAGE, offset: scanned })
    scanned += rows.length

    for (const row of rows) {
      const match = keep(row)
      if (match) matches.push(match)
    }

    if (rows.length < SCAN_PAGE) {
      exhausted = true
      break
    }
  }

  return { matches, scanned, exhausted }
}

export const runUnreadEmailRead = (database: Database, argumentsValue: UnreadEmailArguments): CallToolResult => {
  const schema = getSchemaInfo(database)
  ensureRequiredColumns(schema)

  const { config, warnings: configWarnings } = resolveConfigForRead(database)

  const providerByAccount = getProviderByAccount(config)
  const allAccountKeys = new Set<string>()
  const needed = argumentsValue.offset + argumentsValue.limit

  const scan = scanForMatches(
    (page) => database.query(buildUnreadMessagesQuery(schema, page)).all() as EmailRow[],
    (row) => {
      const accountKey = getMailboxAccountKey(cleanText(row.mailboxUrl) ?? "")
      if (accountKey) allAccountKeys.add(accountKey)

      const email = normalizeEmail(row, providerByAccount, config, { includeArchivedGmail: false })
      if (!email) return undefined
      if (argumentsValue.provider && email.provider !== argumentsValue.provider) return undefined
      if (!matchesMailboxFilter(email, argumentsValue.mailbox)) return undefined
      return email
    },
    needed,
  )

  const emails = scan.matches.slice(argumentsValue.offset, needed)
  const unconfiguredKeys = [...allAccountKeys].filter((key) => !config.accounts[key])
  const warnings: string[] = [...configWarnings]
  if (!scan.exhausted && scan.matches.length < needed) {
    warnings.push(
      `⚠️ Stopped after examining ${scan.scanned} messages without filling the page. More may match; narrow the filter, or page with offset.`,
    )
  }
  if (unconfiguredKeys.length > 0) {
    warnings.push(
      `⚠️ ${unconfiguredKeys.length} unconfigured account(s): ${unconfiguredKeys.join(", ")}. Edit ${resolveConfigPath()} to classify them.`,
    )
  }

  return {
    content: [
      {
        type: "text",
        text:
          (warnings.length > 0 ? `${warnings.join("\n")}\n\n` : "") +
          formatEmailsForContent(emails, argumentsValue, config),
      },
    ],
    structuredContent: {
      source: SOURCE_NAME,
      query: {
        limit: argumentsValue.limit,
        ...(argumentsValue.provider ? { provider: argumentsValue.provider } : {}),
        ...(argumentsValue.mailbox ? { mailbox: argumentsValue.mailbox } : {}),
        timeZone: TIME_ZONE,
      },
      messages: emails,
    },
  }
}

export type MailboxInventoryRow = { mailboxUrl: string; unreadCount: number | null }

/** Groups the mailbox inventory by account and applies whatever the config says about each. */
export const summarizeMailAccounts = (
  rows: MailboxInventoryRow[],
  config: EmailConfig,
  configPath: string,
): ListMailAccountsResult => {
  const byAccount = new Map<string, MailAccountSummary>()

  for (const row of rows) {
    const mailboxUrl = cleanText(row.mailboxUrl) ?? ""
    if (!mailboxUrl) continue

    const accountId = getMailboxAccountKey(mailboxUrl)
    const unreadCount = row.unreadCount ?? 0

    let account = byAccount.get(accountId)
    if (!account) {
      const configured = config.accounts[accountId]
      account = {
        accountId,
        label: configured?.label ?? "unknown",
        category: configured?.category ?? "unknown",
        provider: configured?.provider ?? "unknown",
        unreadCount: 0,
        mailboxes: [],
      }
      byAccount.set(accountId, account)
    }

    account.unreadCount += unreadCount
    account.mailboxes.push({ name: getMailboxName(mailboxUrl), mailboxUrl, unreadCount })
  }

  const accounts = [...byAccount.values()].sort((a, b) => a.label.localeCompare(b.label))
  for (const account of accounts) {
    account.mailboxes.sort((a, b) => b.unreadCount - a.unreadCount || a.name.localeCompare(b.name))
  }

  return { source: SOURCE_NAME, configPath, accounts }
}

/** The human-readable half: what to pass to `mailbox` and `provider`, and where labels come from. */
export const describeMailAccounts = (result: ListMailAccountsResult): string => {
  if (result.accounts.length === 0) {
    return "No mail accounts found in the Envelope Index."
  }

  const lines = result.accounts.flatMap((account) => [
    `${account.label} (${account.category}) — provider "${account.provider}", ${account.unreadCount} unread`,
    `  account id: ${account.accountId}`,
    ...account.mailboxes.map((mailbox) => `  - ${mailbox.name || "(no name)"} — ${mailbox.unreadCount} unread`),
  ])

  return [
    `${result.accounts.length} account(s). Pass a mailbox name, or any substring of one, as "mailbox"; pass the provider as "provider".`,
    "",
    ...lines,
    "",
    `Labels and categories come from ${result.configPath}.`,
  ].join("\n")
}

/**
 * The accounts and mailboxes the other mail tools accept as filters. Without it, `provider` and
 * `mailbox` are guesses, and a wrong guess is indistinguishable from an empty mailbox.
 */
export const createListMailAccountsResult = async (): Promise<CallToolResult> => {
  let database: Database | undefined

  try {
    const db = new Database(MAIL_DB_PATH, { readonly: true })
    database = db
    ensureRequiredColumns(getSchemaInfo(db))

    const { config } = resolveConfigForRead(db)
    const rows = db.query(buildMailboxInventoryQuery(getSchemaInfo(db))).all() as MailboxInventoryRow[]
    const result = summarizeMailAccounts(rows, config, resolveConfigPath())
    const text = describeMailAccounts(result)

    return { content: [{ type: "text", text }], structuredContent: result as unknown as Record<string, unknown> }
  } catch (error) {
    throw error instanceof EmailToolError ? error : new EmailToolError(`Email read failed: ${String(error)}`)
  } finally {
    database?.close()
  }
}

export const createUnreadEmailsResult = async (argumentsValue: UnreadEmailArguments): Promise<CallToolResult> => {
  let database: Database | undefined

  try {
    database = new Database(MAIL_DB_PATH, { readonly: true })
    return runUnreadEmailRead(database, argumentsValue)
  } catch (error) {
    const message = error instanceof EmailToolError ? error.message : `Email read failed: ${errorMessage(error)}`

    return {
      content: [
        {
          type: "text",
          text: message,
        },
      ],
      structuredContent: {
        source: SOURCE_NAME,
        query: {
          limit: argumentsValue.limit,
          ...(argumentsValue.provider ? { provider: argumentsValue.provider } : {}),
          ...(argumentsValue.mailbox ? { mailbox: argumentsValue.mailbox } : {}),
          timeZone: TIME_ZONE,
        },
        messages: [],
      },
      isError: true,
    }
  } finally {
    database?.close(false)
  }
}

export const createSearchEmailResult = async (args: SearchEmailArguments): Promise<CallToolResult> => {
  let database: Database | undefined

  try {
    const db = new Database(MAIL_DB_PATH, { readonly: true })
    database = db
    const schema = getSchemaInfo(db)
    ensureRequiredColumns(schema)

    const { config } = resolveConfigForRead(db)

    const providerByAccount = getProviderByAccount(config)
    const needed = args.offset + args.limit
    const scan = scanForMatches(
      (page) => {
        const { sql, params } = buildSearchMessagesQuery(schema, args, page)
        return db.query(sql).all(...params) as (EmailRow & { readFlag?: number | null })[]
      },
      (row) => {
        const normalized = normalizeEmail(row, providerByAccount, config, { includeArchivedGmail: true })
        if (!normalized) return undefined
        // The query returns read and unread alike, so the flag decides rather than the caller.
        normalized.isUnread = row.readFlag === 0
        if (args.provider && normalized.provider !== args.provider) return undefined
        if (!matchesMailboxFilter(normalized, args.mailbox)) return undefined
        return normalized
      },
      needed,
    )

    const emails = scan.matches.slice(args.offset, needed)

    return {
      content: [
        {
          type: "text",
          text: formatSearchEmailSummary(emails, args),
        },
      ],
      structuredContent: {
        source: SOURCE_NAME,
        query: {
          limit: args.limit,
          ...(args.provider ? { provider: args.provider } : {}),
          ...(args.mailbox ? { mailbox: args.mailbox } : {}),
          ...(args.subject ? { subject: args.subject } : {}),
          ...(args.sender ? { sender: args.sender } : {}),
          ...(args.after ? { after: args.after } : {}),
          ...(args.before ? { before: args.before } : {}),
          ...(args.unreadOnly ? { unreadOnly: args.unreadOnly } : {}),
          timeZone: TIME_ZONE,
        },
        messages: emails,
      },
    }
  } catch (error) {
    const message = error instanceof EmailToolError ? error.message : `Email search failed: ${errorMessage(error)}`

    return {
      content: [
        {
          type: "text",
          text: message,
        },
      ],
      structuredContent: {
        source: SOURCE_NAME,
        query: {
          limit: args.limit,
          timeZone: TIME_ZONE,
        },
        messages: [],
      },
      isError: true,
    }
  } finally {
    database?.close(false)
  }
}
