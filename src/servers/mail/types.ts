// Shape of everything the mail server passes around: rows as they come out of the Envelope Index,
// the normalized email the tools return, and one argument/result pair per tool. Kept apart from
// mail.ts so the modules split out of it can share these without importing the server.

export type TableColumnRow = {
  name: string
}

export type MailboxUrlRow = {
  mailboxUrl: string | null
}

export type EmailRow = {
  documentId: string | null
  mailboxUrl: string | null
  messageIdText: string | null
  receivedAtUnix: number | null
  resolvedSenderAddress: string | null
  resolvedSenderName: string | null
  resolvedSubject: string | null
  rowIdText: string
  senderReferenceText: string | null
  subjectPrefix: string | null
  subjectReferenceText: string | null
  readFlag?: number | null
  messageIdHeader?: string | null
}

export type NormalizedEmail = {
  id: string
  handle: EmailHandle
  subject: string
  senderName: string
  senderAddress: string
  mailboxName: string
  mailboxUrl: string
  provider: "gmail" | "icloud"
  accountLabel: string
  accountCategory: string
  receivedAt: string
  receivedAtLocal: string
  isUnread: boolean
  messageUrl: string
  source: string
}

export type EmailHandle = {
  accountId: string
  mailboxUrl: string
  mailId: string
}

export type AccountClassification = Pick<NormalizedEmail, "accountLabel" | "accountCategory">

export type EmailAccountConfig = {
  label: string
  category: string
  provider: "gmail" | "icloud" | "unknown"
}

export type EmailConfig = {
  accounts: Record<string, EmailAccountConfig>
  displayOrder: string[]
}

export type EmailGroup = AccountClassification & {
  messages: NormalizedEmail[]
}

export type UnreadEmailArguments = {
  offset: number
  limit: number
  mailbox?: string
  provider?: "gmail" | "icloud"
}

export type SearchEmailArguments = {
  offset: number
  subject?: string
  sender?: string
  after?: string
  before?: string
  mailbox?: string
  provider?: "gmail" | "icloud"
  unreadOnly?: boolean
  limit: number
}

export type MarkEmailsReadArguments = {
  emails: MarkEmailsReadTarget[]
}

export type MarkEmailsReadTarget = {
  id: string
  subject?: string
  handle: EmailHandle
}

export type MarkEmailsReadResult = {
  id: string
  subject?: string
  handle: EmailHandle
  status: "marked_read" | "already_read" | "not_found" | "invalid_handle" | "error"
  detail?: string
}

export type FetchEmailBodyArguments = {
  handle: EmailHandle
}

export type FetchEmailBodyResult = {
  handle: EmailHandle
  body: string
  found: boolean
  truncated: boolean
}

export type ExtractEmailLinksArguments = {
  handle: EmailHandle
}

export type EmailLink = {
  url: string
  text: string
}

export type ExtractEmailLinksResult = {
  handle: EmailHandle
  found: boolean
  links: EmailLink[]
  count: number
  truncated: boolean
}

export type ListEmailAttachmentsArguments = {
  handle: EmailHandle
}

export type EmailAttachment = {
  name: string
  downloaded: boolean
}

export type ListEmailAttachmentsResult = {
  handle: EmailHandle
  found: boolean
  attachments: EmailAttachment[]
}

export type FetchEmailAttachmentArguments = {
  handle: EmailHandle
  attachmentName: string
  format: "text" | "base64"
}

export type FetchEmailAttachmentResult = {
  handle: EmailHandle
  name: string
  mimeType: string
  sizeBytes: number
  content: string
  format: "text" | "base64"
}

export type MarkEmailsJunkArguments = {
  emails: MarkEmailsJunkTarget[]
}

export type MarkEmailsJunkTarget = {
  id: string
  subject?: string
  handle: EmailHandle
}

export type MarkEmailsJunkResult = {
  id: string
  subject?: string
  handle: EmailHandle
  status: "marked_junk" | "already_junk" | "not_found" | "invalid_handle" | "no_junk_mailbox" | "error"
  detail?: string
}

export type MarkEmailsNotJunkArguments = {
  emails: MarkEmailsNotJunkTarget[]
}

export type MarkEmailsNotJunkTarget = {
  id: string
  subject?: string
  handle: EmailHandle
}

export type MarkEmailsNotJunkResult = {
  id: string
  subject?: string
  handle: EmailHandle
  status: "marked_not_junk" | "already_not_junk" | "not_found" | "invalid_handle" | "no_inbox_mailbox" | "error"
  detail?: string
}

export type FlagEmailsArguments = {
  emails: FlagEmailsTarget[]
}

export type FlagEmailsTarget = {
  id: string
  subject?: string
  handle: EmailHandle
  flagIndex?: number
  flaggedStatus?: boolean
  backgroundColor?: string
}

export type FlagEmailsResult = {
  id: string
  subject?: string
  handle: EmailHandle
  status: "flagged" | "not_found" | "invalid_handle" | "error"
  detail?: string
}

export type SendEmailArguments = {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
  from?: string
}

export type SendEmailResult = {
  status: "sent" | "error"
  detail?: string
  recipientCount?: number
}

export type ReplyEmailArguments = {
  handle: EmailHandle
  body: string
  replyAll?: boolean
  from?: string
}

export type ReplyEmailResult = {
  status: "sent" | "not_found" | "invalid_handle" | "error"
  detail?: string
}

export type ForwardEmailArguments = {
  handle: EmailHandle
  to: string[]
  cc?: string[]
  bcc?: string[]
  body?: string
  from?: string
}

export type ForwardEmailResult = {
  status: "sent" | "not_found" | "invalid_handle" | "error"
  detail?: string
  recipientCount?: number
}

export type MailboxSummary = {
  name: string
  mailboxUrl: string
  unreadCount: number
}

export type MailAccountSummary = {
  accountId: string
  label: string
  category: string
  provider: string
  unreadCount: number
  mailboxes: MailboxSummary[]
}

export type ListMailAccountsResult = {
  source: string
  configPath: string
  accounts: MailAccountSummary[]
}

export type SchemaInfo = {
  addresses: Set<string>
  mailboxes: Set<string>
  messageGlobalData: Set<string>
  messages: Set<string>
  senderAddresses: Set<string>
  senders: Set<string>
  subjects: Set<string>
}
