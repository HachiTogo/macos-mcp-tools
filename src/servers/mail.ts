import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { DESTRUCTIVE, READ, SEND, SET } from "../lib/annotations"
import { runTool } from "../lib/mcp-result"
import { serve } from "../lib/serve"
import { PACKAGE_VERSION } from "../lib/version"
import { MAX_EMAIL_BODY_LENGTH } from "./mail/constants"
import {
  createExtractEmailLinksResult,
  createFetchEmailAttachmentResult,
  createFetchEmailBodyResult,
  createListEmailAttachmentsResult,
} from "./mail/message-content"
import {
  createFlagEmailsResult,
  createForwardEmailResult,
  createMarkEmailsJunkResult,
  createMarkEmailsNotJunkResult,
  createMarkEmailsReadResult,
  createReplyEmailResult,
  createSendEmailResult,
} from "./mail/mutate"
import {
  emailAttachmentOutput,
  emailAttachmentsOutput,
  emailBodyOutput,
  emailLinksOutput,
  emailListOutput,
  mailAccountsOutput,
} from "./mail/output"
import { createListMailAccountsResult, createSearchEmailResult, createUnreadEmailsResult } from "./mail/read"
import {
  emailsArraySchema,
  handleSchema,
  hasSearchCriteria,
  isoDateString,
  limitSchema,
  offsetSchema,
} from "./mail/schemas"

// ── MCP Server ─────────────────────────────────────────────────────────

const provider = z
  .string()
  .min(1)
  .optional()
  .describe("Only accounts with this provider, as list_mail_accounts reports it (e.g. 'gmail', 'icloud', 'unknown').")

const server = new McpServer({ name: "apple-mail", version: PACKAGE_VERSION })

server.registerTool(
  "list_mail_accounts",
  {
    description:
      "List the Apple Mail accounts and mailboxes this server can see, with unread counts. Call this before filtering: 'provider' and 'mailbox' on list_unread_emails and search_emails only accept values that exist here, and a value that matches nothing returns an empty result rather than an error.",
    inputSchema: {},
    outputSchema: mailAccountsOutput,
    annotations: READ,
  },
  async () => runTool("list_mail_accounts", () => createListMailAccountsResult()),
)

server.registerTool(
  "list_unread_emails",
  {
    description:
      "Read unread Apple Mail messages without fetching bodies. Counts every unread message, in every category. For Gmail, that means mail in the inbox or under any label; archived mail with no label is left out, and each message is reported under its label rather than as INBOX.",
    inputSchema: {
      limit: limitSchema.describe("Maximum number of messages to return (1–100). Default: 25."),
      offset: offsetSchema.describe("Skip this many matching messages before returning; use with limit to page."),
      provider,
      mailbox: z.string().optional().describe("Substring filter on mailbox name or URL (e.g. 'INBOX', 'work')."),
    },
    outputSchema: emailListOutput,
    annotations: READ,
  },
  async (args) => runTool("list_unread_emails", () => createUnreadEmailsResult(args)),
)

server.registerTool(
  "mark_emails_read",
  {
    description:
      "Mark Apple Mail messages as read. Each item in 'emails' must be a full email object with 'id', 'subject', and 'handle' fields — pass the objects exactly as returned by list_unread_emails, not bare handle objects.",
    inputSchema: {
      emails: emailsArraySchema.describe("Array of email objects to mark as read."),
    },
    annotations: SET,
  },
  async (args) => runTool("mark_emails_read", () => createMarkEmailsReadResult(args)),
)

server.registerTool(
  "fetch_email_body",
  {
    description: "Fetch the full body text of a single Apple Mail message by its handle.",
    inputSchema: {
      handle: handleSchema.describe("Email handle identifying the message."),
    },
    outputSchema: emailBodyOutput,
    annotations: READ,
  },
  async (args) => runTool("fetch_email_body", () => createFetchEmailBodyResult(args)),
)

server.registerTool(
  "extract_email_links",
  {
    description:
      "Extract all hyperlinks from an Apple Mail message as `{ url, text }` pairs. Reads the raw HTML source server-side (never returned to the caller) and returns just the link pairs. Use this when you need URLs for navigation, link auditing, or extracting actionable links from marketing emails.",
    inputSchema: {
      handle: handleSchema.describe("Email handle identifying the message."),
    },
    outputSchema: emailLinksOutput,
    annotations: READ,
  },
  async (args) => runTool("extract_email_links", () => createExtractEmailLinksResult(args)),
)

server.registerTool(
  "mark_emails_junk",
  {
    description:
      "Mark Apple Mail messages as junk/spam. Each item in 'emails' must be a full email object with 'id', 'subject', and 'handle' fields — pass the objects exactly as returned by list_unread_emails, not bare handle objects.",
    inputSchema: {
      emails: emailsArraySchema.describe("Array of email objects to mark as junk."),
    },
    annotations: DESTRUCTIVE,
  },
  async (args) => runTool("mark_emails_junk", () => createMarkEmailsJunkResult(args)),
)

server.registerTool(
  "mark_emails_not_junk",
  {
    description:
      "Mark Apple Mail messages as not junk. Each item in 'emails' must be a full email object with 'id', 'subject', and 'handle' fields — pass the objects exactly as returned by list_unread_emails, not bare handle objects.",
    inputSchema: {
      emails: emailsArraySchema.describe("Array of email objects to mark as not junk."),
    },
    annotations: SET,
  },
  async (args) => runTool("mark_emails_not_junk", () => createMarkEmailsNotJunkResult(args)),
)

server.registerTool(
  "flag_emails",
  {
    description:
      "Set flag color, flagged status, or background color on Apple Mail messages. Each item in 'emails' must include 'id', 'handle', and at least one of 'flag_index', 'flagged_status', or 'background_color'.",
    inputSchema: {
      emails: z
        .array(
          z.object({
            id: z.string(),
            subject: z.string().optional(),
            handle: handleSchema,
            flag_index: z
              .number()
              .int()
              .min(-1)
              .max(6)
              .optional()
              .describe("Flag color index: -1=unflagged, 0=red, 1=orange, 2=yellow, 3=green, 4=blue, 5=purple, 6=gray"),
            flagged_status: z
              .boolean()
              .optional()
              .describe("Set flagged status directly. true=flagged, false=unflagged."),
            background_color: z
              .enum(["blue", "gray", "green", "none", "orange", "purple", "red", "yellow"])
              .optional()
              .describe("Message background color in Mail.app."),
          }),
        )
        .min(1)
        .describe("Array of email objects to flag."),
    },
    annotations: SET,
  },
  async ({ emails }) =>
    runTool("flag_emails", () =>
      createFlagEmailsResult({
        emails: emails.map(({ flag_index, flagged_status, background_color, ...email }) => ({
          ...email,
          flagIndex: flag_index,
          flaggedStatus: flagged_status,
          backgroundColor: background_color,
        })),
      }),
    ),
)

server.registerTool(
  "list_email_attachments",
  {
    description: "Lists attachments on a message without downloading content.",
    inputSchema: {
      handle: handleSchema.describe("Email handle identifying the message."),
    },
    outputSchema: emailAttachmentsOutput,
    annotations: READ,
  },
  async (args) => runTool("list_email_attachments", () => createListEmailAttachmentsResult(args)),
)

server.registerTool(
  "fetch_email_attachment",
  {
    description: "Downloads a single attachment and returns its content.",
    inputSchema: {
      handle: handleSchema.describe("Email handle identifying the message."),
      attachment_name: z
        .string()
        .min(1)
        .describe("Name of the attachment to fetch, as listed by list_email_attachments."),
      format: z
        .enum(["text", "base64"])
        .default("text")
        .describe("Return format: 'text' for plain text / PDF extraction, 'base64' for binary. Defaults to 'text'."),
    },
    outputSchema: emailAttachmentOutput,
    annotations: READ,
  },
  async ({ attachment_name, ...args }) =>
    runTool("fetch_email_attachment", () =>
      createFetchEmailAttachmentResult({ ...args, attachmentName: attachment_name }),
    ),
)

server.registerTool(
  "search_emails",
  {
    description:
      "Search emails by subject, sender, and/or date range. Returns matching emails from all accounts, except mail in Junk, Spam, Trash, Deleted Messages, Sent Messages, Sent Mail, Drafts or Outbox, which it never returns. At least one search criterion (subject, sender, after, before) is required.",
    inputSchema: {
      subject: z.string().optional().describe("Substring to match in the email subject line."),
      sender: z.string().optional().describe("Substring to match in the sender email address or display name."),
      after: isoDateString("after")
        .optional()
        .describe(
          "ISO 8601 date. Only return emails received on or after it. A bare date means local midnight; add a time or zone to be explicit. Example: '2025-01-15' or '2025-01-15T09:00:00Z'.",
        ),
      before: isoDateString("before")
        .optional()
        .describe(
          "ISO 8601 date. Only return emails received strictly before it. A bare date means local midnight. Example: '2025-03-01'.",
        ),
      limit: limitSchema.describe("Maximum number of results to return (1–100). Default: 25."),
      offset: offsetSchema.describe("Skip this many matching messages before returning; use with limit to page."),
      provider,
      mailbox: z.string().optional().describe("Substring filter on mailbox name or URL (e.g. 'INBOX', 'work')."),
      unread_only: z.boolean().optional().describe("If true, only return unread emails. Defaults to false."),
    },
    outputSchema: emailListOutput,
    annotations: READ,
  },
  async ({ unread_only, ...args }) =>
    runTool("search_emails", () => {
      // Not expressible in the input schema: registerTool takes a shape, not an object, so there is
      // nowhere to hang a cross-field refinement.
      if (!hasSearchCriteria(args)) {
        throw new Error("At least one of 'subject', 'sender', 'after', or 'before' is required.")
      }
      return createSearchEmailResult({ ...args, unreadOnly: unread_only })
    }),
)

server.registerTool(
  "send_email",
  {
    description:
      "Compose and send a new email via Apple Mail. Requires at least one 'to' recipient. Plain text body only.",
    inputSchema: {
      to: z.array(z.string().email()).min(1).describe("Recipient email addresses. At least one required."),
      cc: z.array(z.string().email()).optional().describe("CC recipient email addresses."),
      bcc: z.array(z.string().email()).optional().describe("BCC recipient email addresses."),
      subject: z.string().min(1).describe("Email subject line."),
      body: z.string().min(1).max(MAX_EMAIL_BODY_LENGTH).describe("Plain text email body."),
      from: z.string().email().optional().describe("Optional sender email address. Must match an enabled account."),
    },
    annotations: SEND,
  },
  async (args) => runTool("send_email", () => createSendEmailResult(args)),
)

server.registerTool(
  "reply_email",
  {
    description: "Reply to an existing Apple Mail message by handle. Set reply_all=true to reply to all recipients.",
    inputSchema: {
      handle: handleSchema.describe("Email handle identifying the message being replied to."),
      body: z
        .string()
        .min(1)
        .max(MAX_EMAIL_BODY_LENGTH)
        .describe("Plain text reply body. Prepended above the quoted original."),
      reply_all: z.boolean().optional().describe("If true, reply to all recipients of the original message."),
      from: z.string().email().optional().describe("Optional sender email address override."),
    },
    annotations: SEND,
  },
  async ({ reply_all, ...args }) =>
    runTool("reply_email", () => createReplyEmailResult({ ...args, replyAll: reply_all })),
)

server.registerTool(
  "forward_email",
  {
    description: "Forward an existing Apple Mail message to new recipients.",
    inputSchema: {
      handle: handleSchema.describe("Email handle identifying the message being forwarded."),
      to: z.array(z.string().email()).min(1).describe("Recipient email addresses. At least one required."),
      cc: z.array(z.string().email()).optional().describe("CC recipient email addresses."),
      bcc: z.array(z.string().email()).optional().describe("BCC recipient email addresses."),
      body: z
        .string()
        .max(MAX_EMAIL_BODY_LENGTH)
        .optional()
        .describe("Optional message to prepend above the forwarded content."),
      from: z.string().email().optional().describe("Optional sender email address override."),
    },
    annotations: SEND,
  },
  async (args) => runTool("forward_email", () => createForwardEmailResult(args)),
)

// ── Entry point ────────────────────────────────────────────────────────

export const main = () => serve(server)

// Boot only when executed directly; cli.ts and tests import this module without starting a server.
if (import.meta.main) {
  await main()
}
