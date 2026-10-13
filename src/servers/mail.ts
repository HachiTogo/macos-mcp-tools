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

// Descriptions say only what a field's name and type cannot.
const provider = z.string().min(1).optional().describe("From list_mail_accounts, e.g. 'gmail'")
const mailbox = z.string().optional().describe("Substring of a mailbox name or URL")
const from = z.string().email().optional().describe("Must match an enabled account")
/** The mark and junk tools need the objects the read tools return, which agents shorten to handles. */
const EMAILS = "Pass the email objects list_unread_emails or search_emails returned, not bare handles."

const server = new McpServer({ name: "apple-mail", version: PACKAGE_VERSION })

server.registerTool(
  "list_mail_accounts",
  {
    description:
      "Mail accounts and mailboxes, with unread counts. The provider and mailbox filters take values from here; one that matches nothing returns no mail and a warning.",
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
      "Unread messages in every category, without bodies. Gmail mail counts in the inbox or under a label, is reported under its label, and archived mail is left out.",
    inputSchema: {
      limit: limitSchema,
      offset: offsetSchema,
      provider,
      mailbox,
    },
    outputSchema: emailListOutput,
    annotations: READ,
  },
  async (args) => runTool("list_unread_emails", () => createUnreadEmailsResult(args)),
)

server.registerTool(
  "mark_emails_read",
  {
    description: `Mark messages read. ${EMAILS}`,
    inputSchema: {
      emails: emailsArraySchema,
    },
    annotations: SET,
  },
  async (args) => runTool("mark_emails_read", () => createMarkEmailsReadResult(args)),
)

server.registerTool(
  "fetch_email_body",
  {
    description: "A message's full body text.",
    inputSchema: {
      handle: handleSchema,
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
      "A message's links as { url, text } pairs, read from its HTML source; the HTML itself is not returned.",
    inputSchema: {
      handle: handleSchema,
    },
    outputSchema: emailLinksOutput,
    annotations: READ,
  },
  async (args) => runTool("extract_email_links", () => createExtractEmailLinksResult(args)),
)

server.registerTool(
  "mark_emails_junk",
  {
    description: `Mark messages as junk. ${EMAILS}`,
    inputSchema: {
      emails: emailsArraySchema,
    },
    annotations: DESTRUCTIVE,
  },
  async (args) => runTool("mark_emails_junk", () => createMarkEmailsJunkResult(args)),
)

server.registerTool(
  "mark_emails_not_junk",
  {
    description: `Mark messages as not junk. ${EMAILS}`,
    inputSchema: {
      emails: emailsArraySchema,
    },
    annotations: SET,
  },
  async (args) => runTool("mark_emails_not_junk", () => createMarkEmailsNotJunkResult(args)),
)

server.registerTool(
  "flag_emails",
  {
    description:
      "Set flag color, flagged status or background color. Each item needs id, handle and at least one of the three.",
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
              .describe("-1 none, 0 red, 1 orange, 2 yellow, 3 green, 4 blue, 5 purple, 6 gray"),
            flagged_status: z.boolean().optional(),
            background_color: z.enum(["blue", "gray", "green", "none", "orange", "purple", "red", "yellow"]).optional(),
          }),
        )
        .min(1),
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
    description: "A message's attachment names, without downloading them.",
    inputSchema: {
      handle: handleSchema,
    },
    outputSchema: emailAttachmentsOutput,
    annotations: READ,
  },
  async (args) => runTool("list_email_attachments", () => createListEmailAttachmentsResult(args)),
)

server.registerTool(
  "fetch_email_attachment",
  {
    description: "One attachment's content: text (PDFs through pdftotext) or base64.",
    inputSchema: {
      handle: handleSchema,
      attachment_name: z.string().min(1).describe("As list_email_attachments lists it"),
      format: z.enum(["text", "base64"]).default("text"),
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
      "Search every account by subject, sender or date; at least one is required. Never returns mail in Junk, Spam, Trash, Deleted Messages, Sent Messages, Sent Mail, Drafts or Outbox.",
    inputSchema: {
      subject: z.string().optional().describe("Substring"),
      sender: z.string().optional().describe("Substring of the address or name"),
      after: isoDateString("after").optional().describe("ISO 8601, inclusive; a bare date is local midnight"),
      before: isoDateString("before").optional().describe("ISO 8601, exclusive"),
      limit: limitSchema,
      offset: offsetSchema,
      provider,
      mailbox,
      unread_only: z.boolean().optional(),
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
    description: "Send a new plain-text email.",
    inputSchema: {
      to: z.array(z.string().email()).min(1),
      cc: z.array(z.string().email()).optional(),
      bcc: z.array(z.string().email()).optional(),
      subject: z.string().min(1),
      body: z.string().min(1).max(MAX_EMAIL_BODY_LENGTH),
      from,
    },
    annotations: SEND,
  },
  async (args) => runTool("send_email", () => createSendEmailResult(args)),
)

server.registerTool(
  "reply_email",
  {
    description: "Reply to a message; the plain-text body goes above the quoted original.",
    inputSchema: {
      handle: handleSchema,
      body: z.string().min(1).max(MAX_EMAIL_BODY_LENGTH),
      reply_all: z.boolean().optional(),
      from,
    },
    annotations: SEND,
  },
  async ({ reply_all, ...args }) =>
    runTool("reply_email", () => createReplyEmailResult({ ...args, replyAll: reply_all })),
)

server.registerTool(
  "forward_email",
  {
    description: "Forward a message; an optional body goes above it.",
    inputSchema: {
      handle: handleSchema,
      to: z.array(z.string().email()).min(1),
      cc: z.array(z.string().email()).optional(),
      bcc: z.array(z.string().email()).optional(),
      body: z.string().max(MAX_EMAIL_BODY_LENGTH).optional(),
      from,
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
