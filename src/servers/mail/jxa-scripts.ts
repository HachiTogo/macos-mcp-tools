// The JXA scripts the mail server runs through src/lib/jxa.ts. They live apart from the server
// because they are inert data: static String.raw sources handed to osascript with their inputs
// passed as JSON over argv, never interpolated. Moving them here is what lets mail.ts read as
// TypeScript rather than as 900 lines of embedded JavaScript.

/**
 * getMailboxName from mailbox.ts, as JXA source. A mutation finds its mailbox by name, so it has
 * to compute the same name a read displayed; ten hand-copied versions of this used to disagree
 * with the TypeScript one on pathless URLs, trailing slashes and doubled slashes, which surfaced
 * as `invalid_handle` on a mailbox that had just been listed successfully.
 *
 * Prepended to each script rather than interpolated into it: the scripts stay static text with
 * their inputs passed as JSON over argv, so there is still nothing to inject into.
 */
export const MAILBOX_NAME_JXA = String.raw`
const decodeMailboxPart = (value) => {
  try {
    return decodeURIComponent(value)
  } catch (error) {
    return value
  }
}
const getMailboxName = (mailboxUrl) =>
  mailboxUrl
    .replace(/^[a-z]+:\/\/[^/]+/i, "")
    .split("/")
    .filter(Boolean)
    .map(decodeMailboxPart)
    .join("/")
`

export const MARK_EMAILS_READ_JXA =
  MAILBOX_NAME_JXA +
  String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")
  const targets = Array.isArray(input.targets) ? input.targets : []
  const results = targets.map((target) => {
    const baseResult = {
      id: target.id,
      subject: target.subject,
      handle: target.handle,
    }

    try {
      const handle = target.handle || {}
      const accountId = typeof handle.accountId === "string" ? handle.accountId : ""
      const mailboxUrl = typeof handle.mailboxUrl === "string" ? handle.mailboxUrl : ""
      const mailId = typeof handle.mailId === "string" ? handle.mailId : ""
      const mailboxName = getMailboxName(mailboxUrl)

      if (!accountId || !mailId || !mailboxName) {
        return {
          ...baseResult,
          status: "invalid_handle",
          detail: "Missing accountId, mailboxUrl, or mailId.",
        }
      }

      const account = Mail.accounts.byId(accountId)

      if (typeof account.exists === "function" && !account.exists()) {
        return {
          ...baseResult,
          status: "not_found",
        }
      }

      const mailbox = account.mailboxes.byName(mailboxName)

      if (typeof mailbox.exists === "function" && !mailbox.exists()) {
        return {
          ...baseResult,
          status: "not_found",
        }
      }

      const matchedMessage = mailbox.messages.byId(Number(mailId))

      if (typeof matchedMessage.exists === "function" && !matchedMessage.exists()) {
        return {
          ...baseResult,
          status: "not_found",
        }
      }

      if (matchedMessage.readStatus()) {
        return {
          ...baseResult,
          status: "already_read",
        }
      }

      matchedMessage.readStatus = true

      return {
        ...baseResult,
        status: "marked_read",
      }
    } catch (error) {
      return {
        ...baseResult,
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  })

  return JSON.stringify({ results })
}
`

export const FETCH_EMAIL_BODY_JXA =
  MAILBOX_NAME_JXA +
  String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")
  const handle = input.handle || {}
  const accountId = typeof handle.accountId === "string" ? handle.accountId : ""
  const mailboxUrl = typeof handle.mailboxUrl === "string" ? handle.mailboxUrl : ""
  const mailId = typeof handle.mailId === "string" ? handle.mailId : ""

  if (!accountId || !mailId || !mailboxUrl) {
    return JSON.stringify({ found: false, body: "" })
  }

  try {
    const account = Mail.accounts.byId(accountId)
    if (typeof account.exists === "function" && !account.exists()) {
      return JSON.stringify({ found: false, body: "" })
    }
    const mailboxName = getMailboxName(mailboxUrl)
    const mailbox = account.mailboxes.byName(mailboxName)
    if (typeof mailbox.exists === "function" && !mailbox.exists()) {
      return JSON.stringify({ found: false, body: "" })
    }
    const message = mailbox.messages.byId(Number(mailId))
    if (typeof message.exists === "function" && !message.exists()) {
      return JSON.stringify({ found: false, body: "" })
    }
    const body = message.content() || ""
    return JSON.stringify({ found: true, body })
  } catch (error) {
    return JSON.stringify({ found: false, body: "", error: error instanceof Error ? error.message : String(error) })
  }
}
`

export const FETCH_EMAIL_SOURCE_JXA =
  MAILBOX_NAME_JXA +
  String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")
  const handle = input.handle || {}
  const accountId = typeof handle.accountId === "string" ? handle.accountId : ""
  const mailboxUrl = typeof handle.mailboxUrl === "string" ? handle.mailboxUrl : ""
  const mailId = typeof handle.mailId === "string" ? handle.mailId : ""

  if (!accountId || !mailId || !mailboxUrl) {
    return JSON.stringify({ found: false, source: "" })
  }

  try {
    const account = Mail.accounts.byId(accountId)
    if (typeof account.exists === "function" && !account.exists()) {
      return JSON.stringify({ found: false, source: "" })
    }
    const mailboxName = getMailboxName(mailboxUrl)
    const mailbox = account.mailboxes.byName(mailboxName)
    if (typeof mailbox.exists === "function" && !mailbox.exists()) {
      return JSON.stringify({ found: false, source: "" })
    }
    const message = mailbox.messages.byId(Number(mailId))
    if (typeof message.exists === "function" && !message.exists()) {
      return JSON.stringify({ found: false, source: "" })
    }
    const source = message.source() || ""
    return JSON.stringify({ found: true, source })
  } catch (error) {
    return JSON.stringify({ found: false, source: "", error: error instanceof Error ? error.message : String(error) })
  }
}
`

export const LIST_EMAIL_ATTACHMENTS_JXA =
  MAILBOX_NAME_JXA +
  String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")
  const handle = input.handle || {}
  const accountId = typeof handle.accountId === "string" ? handle.accountId : ""
  const mailboxUrl = typeof handle.mailboxUrl === "string" ? handle.mailboxUrl : ""
  const mailId = typeof handle.mailId === "string" ? handle.mailId : ""

  if (!accountId || !mailId || !mailboxUrl) {
    return JSON.stringify({ found: false, attachments: [] })
  }

  try {
    const account = Mail.accounts.byId(accountId)
    if (typeof account.exists === "function" && !account.exists()) {
      return JSON.stringify({ found: false, attachments: [] })
    }
    const mailboxName = getMailboxName(mailboxUrl)
    const mailbox = account.mailboxes.byName(mailboxName)
    if (typeof mailbox.exists === "function" && !mailbox.exists()) {
      return JSON.stringify({ found: false, attachments: [] })
    }
    const message = mailbox.messages.byId(Number(mailId))
    if (typeof message.exists === "function" && !message.exists()) {
      return JSON.stringify({ found: false, attachments: [] })
    }
    const attachments = message.mailAttachments()
    const result = attachments.map((att) => ({
      name: att.name(),
      downloaded: att.downloaded(),
    }))
    return JSON.stringify({ found: true, attachments: result })
  } catch (error) {
    return JSON.stringify({ found: false, attachments: [], error: error instanceof Error ? error.message : String(error) })
  }
}
`

export const FETCH_EMAIL_ATTACHMENT_JXA =
  MAILBOX_NAME_JXA +
  String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")
  const handle = input.handle || {}
  const accountId = typeof handle.accountId === "string" ? handle.accountId : ""
  const mailboxUrl = typeof handle.mailboxUrl === "string" ? handle.mailboxUrl : ""
  const mailId = typeof handle.mailId === "string" ? handle.mailId : ""
  const attachmentName = typeof input.attachmentName === "string" ? input.attachmentName : ""
  const savePath = typeof input.savePath === "string" ? input.savePath : ""

  if (!accountId || !mailId || !mailboxUrl || !attachmentName || !savePath) {
    return JSON.stringify({ saved: false, error: "Missing required parameters." })
  }

  try {
    const account = Mail.accounts.byId(accountId)
    if (typeof account.exists === "function" && !account.exists()) {
      return JSON.stringify({ saved: false, error: "Account not found." })
    }
    const mailboxName = getMailboxName(mailboxUrl)
    const mailbox = account.mailboxes.byName(mailboxName)
    if (typeof mailbox.exists === "function" && !mailbox.exists()) {
      return JSON.stringify({ saved: false, error: "Mailbox not found." })
    }
    const message = mailbox.messages.byId(Number(mailId))
    if (typeof message.exists === "function" && !message.exists()) {
      return JSON.stringify({ saved: false, error: "Message not found." })
    }
    const attachments = message.mailAttachments()
    let targetAttachment = null
    for (let i = 0; i < attachments.length; i++) {
      if (attachments[i].name() === attachmentName) {
        targetAttachment = attachments[i]
        break
      }
    }
    if (!targetAttachment) {
      return JSON.stringify({ saved: false, error: "Attachment '" + attachmentName + "' not found on message." })
    }
    if (!targetAttachment.downloaded()) {
      return JSON.stringify({ saved: false, error: "Attachment not downloaded; open message in Mail.app first." })
    }
    Mail.save(targetAttachment, { in: Path(savePath) })
    return JSON.stringify({ saved: true })
  } catch (error) {
    return JSON.stringify({ saved: false, error: error instanceof Error ? error.message : String(error) })
  }
}
`

export const MARK_EMAILS_JUNK_JXA =
  MAILBOX_NAME_JXA +
  String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")
  const targets = Array.isArray(input.targets) ? input.targets : []
  const junkNames = ["junk", "[gmail]/spam", "spam"]

  const findJunkMailbox = (account) => {
    const allMailboxes = account.mailboxes()
    for (const mb of allMailboxes) {
      try {
        const name = mb.name().toLowerCase()
        if (junkNames.includes(name)) return mb
      } catch {
        continue
      }
    }
    return null
  }

  const results = targets.map((target) => {
    const baseResult = {
      id: target.id,
      subject: target.subject,
      handle: target.handle,
    }

    try {
      const handle = target.handle || {}
      const accountId = typeof handle.accountId === "string" ? handle.accountId : ""
      const mailboxUrl = typeof handle.mailboxUrl === "string" ? handle.mailboxUrl : ""
      const mailId = typeof handle.mailId === "string" ? handle.mailId : ""
      const mailboxName = getMailboxName(mailboxUrl)

      if (!accountId || !mailId || !mailboxName) {
        return {
          ...baseResult,
          status: "invalid_handle",
          detail: "Missing accountId, mailboxUrl, or mailId.",
        }
      }

      const account = Mail.accounts.byId(accountId)

      if (typeof account.exists === "function" && !account.exists()) {
        return {
          ...baseResult,
          status: "not_found",
          detail: "Account not found.",
        }
      }

      const junkMailbox = findJunkMailbox(account)

      if (!junkMailbox) {
        return {
          ...baseResult,
          status: "no_junk_mailbox",
          detail: "No Junk or Spam mailbox found for this account.",
        }
      }

      const mailbox = account.mailboxes.byName(mailboxName)

      if (typeof mailbox.exists === "function" && !mailbox.exists()) {
        return {
          ...baseResult,
          status: "not_found",
          detail: "Mailbox not found.",
        }
      }

      const matchedMessage = mailbox.messages.byId(Number(mailId))

      if (typeof matchedMessage.exists === "function" && !matchedMessage.exists()) {
        return {
          ...baseResult,
          status: "not_found",
          detail: "Message not found.",
        }
      }

      const isAlreadyJunk = matchedMessage.junkMailStatus()
      const currentMailboxName = mailbox.name().toLowerCase()
      const isInJunkMailbox = junkNames.includes(currentMailboxName)

      if (isAlreadyJunk && isInJunkMailbox) {
        return {
          ...baseResult,
          status: "already_junk",
        }
      }

      matchedMessage.junkMailStatus = true
      Mail.move(matchedMessage, { to: junkMailbox })

      return {
        ...baseResult,
        status: "marked_junk",
      }
    } catch (error) {
      return {
        ...baseResult,
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  })

  return JSON.stringify({ results })
}
`

export const MARK_EMAILS_NOT_JUNK_JXA =
  MAILBOX_NAME_JXA +
  String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")
  const targets = Array.isArray(input.targets) ? input.targets : []
  const inboxNames = ["inbox"]

  const findInboxMailbox = (account) => {
    const allMailboxes = account.mailboxes()
    for (const mb of allMailboxes) {
      try {
        const name = mb.name().toLowerCase()
        if (inboxNames.includes(name)) return mb
      } catch {
        continue
      }
    }
    return null
  }

  const junkNames = ["junk", "[gmail]/spam", "spam"]

  const results = targets.map((target) => {
    const baseResult = {
      id: target.id,
      subject: target.subject,
      handle: target.handle,
    }

    try {
      const handle = target.handle || {}
      const accountId = typeof handle.accountId === "string" ? handle.accountId : ""
      const mailboxUrl = typeof handle.mailboxUrl === "string" ? handle.mailboxUrl : ""
      const mailId = typeof handle.mailId === "string" ? handle.mailId : ""
      const mailboxName = getMailboxName(mailboxUrl)

      if (!accountId || !mailId || !mailboxName) {
        return {
          ...baseResult,
          status: "invalid_handle",
          detail: "Missing accountId, mailboxUrl, or mailId.",
        }
      }

      const account = Mail.accounts.byId(accountId)

      if (typeof account.exists === "function" && !account.exists()) {
        return {
          ...baseResult,
          status: "not_found",
          detail: "Account not found.",
        }
      }

      const inboxMailbox = findInboxMailbox(account)

      if (!inboxMailbox) {
        return {
          ...baseResult,
          status: "no_inbox_mailbox",
          detail: "No Inbox mailbox found for this account.",
        }
      }

      const mailbox = account.mailboxes.byName(mailboxName)

      if (typeof mailbox.exists === "function" && !mailbox.exists()) {
        return {
          ...baseResult,
          status: "not_found",
          detail: "Mailbox not found.",
        }
      }

      const matchedMessage = mailbox.messages.byId(Number(mailId))

      if (typeof matchedMessage.exists === "function" && !matchedMessage.exists()) {
        return {
          ...baseResult,
          status: "not_found",
          detail: "Message not found.",
        }
      }

      const isJunk = matchedMessage.junkMailStatus()
      const currentMailboxName = mailbox.name().toLowerCase()
      const isInJunkMailbox = junkNames.includes(currentMailboxName)

      if (!isJunk && !isInJunkMailbox) {
        return {
          ...baseResult,
          status: "already_not_junk",
        }
      }

      matchedMessage.junkMailStatus = false
      Mail.move(matchedMessage, { to: inboxMailbox })

      return {
        ...baseResult,
        status: "marked_not_junk",
      }
    } catch (error) {
      return {
        ...baseResult,
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  })

  return JSON.stringify({ results })
}
`

export const FLAG_EMAILS_JXA =
  MAILBOX_NAME_JXA +
  String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")
  const targets = Array.isArray(input.targets) ? input.targets : []
  const results = targets.map((target) => {
    const baseResult = {
      id: target.id,
      subject: target.subject,
      handle: target.handle,
    }

    try {
      const handle = target.handle || {}
      const accountId = typeof handle.accountId === "string" ? handle.accountId : ""
      const mailboxUrl = typeof handle.mailboxUrl === "string" ? handle.mailboxUrl : ""
      const mailId = typeof handle.mailId === "string" ? handle.mailId : ""
      const mailboxName = getMailboxName(mailboxUrl)

      if (!accountId || !mailId || !mailboxName) {
        return {
          ...baseResult,
          status: "invalid_handle",
          detail: "Missing accountId, mailboxUrl, or mailId.",
        }
      }

      const account = Mail.accounts.byId(accountId)

      if (typeof account.exists === "function" && !account.exists()) {
        return {
          ...baseResult,
          status: "not_found",
        }
      }

      const mailbox = account.mailboxes.byName(mailboxName)

      if (typeof mailbox.exists === "function" && !mailbox.exists()) {
        return {
          ...baseResult,
          status: "not_found",
        }
      }

      const matchedMessage = mailbox.messages.byId(Number(mailId))

      if (typeof matchedMessage.exists === "function" && !matchedMessage.exists()) {
        return {
          ...baseResult,
          status: "not_found",
        }
      }

      if (typeof target.flagIndex === "number") {
        matchedMessage.flagIndex = target.flagIndex
      }

      if (typeof target.flaggedStatus === "boolean") {
        matchedMessage.flaggedStatus = target.flaggedStatus
      }

      if (typeof target.backgroundColor === "string") {
        matchedMessage.backgroundColor = target.backgroundColor
      }

      return {
        ...baseResult,
        status: "flagged",
      }
    } catch (error) {
      return {
        ...baseResult,
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  })

  return JSON.stringify({ results })
}
`

export const SEND_EMAIL_JXA = String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")

  try {
    const to = Array.isArray(input.to) ? input.to : []
    const cc = Array.isArray(input.cc) ? input.cc : []
    const bcc = Array.isArray(input.bcc) ? input.bcc : []
    const subject = typeof input.subject === "string" ? input.subject : ""
    const body = typeof input.body === "string" ? input.body : ""
    const fromAddress = typeof input.from === "string" ? input.from.trim() : ""

    if (to.length === 0) {
      return JSON.stringify({ status: "error", detail: "At least one 'to' recipient is required." })
    }

    let sender = ""
    const accounts = Mail.accounts()
    let chosenAccount = null

    if (fromAddress) {
      const target = fromAddress.toLowerCase()
      for (let i = 0; i < accounts.length; i++) {
        const acct = accounts[i]
        try {
          if (typeof acct.enabled === "function" && !acct.enabled()) continue
        } catch (_) {}
        let addresses = []
        try { addresses = acct.emailAddresses() || [] } catch (_) {}
        const match = addresses.some((addr) => typeof addr === "string" && addr.toLowerCase() === target)
        if (match) {
          chosenAccount = acct
          break
        }
      }
      if (!chosenAccount) {
        return JSON.stringify({ status: "error", detail: "No enabled account matches 'from' address: " + fromAddress })
      }
    } else {
      for (let i = 0; i < accounts.length; i++) {
        const acct = accounts[i]
        try {
          if (typeof acct.enabled === "function" && !acct.enabled()) continue
        } catch (_) {}
        chosenAccount = acct
        break
      }
      if (!chosenAccount) {
        return JSON.stringify({ status: "error", detail: "No enabled mail account found." })
      }
    }

    let primaryAddress = ""
    try {
      const addrs = chosenAccount.emailAddresses() || []
      if (addrs.length > 0) primaryAddress = addrs[0]
    } catch (_) {}
    if (fromAddress) primaryAddress = fromAddress

    let fullName = ""
    try { fullName = chosenAccount.fullName() || "" } catch (_) {}

    if (fullName && primaryAddress) {
      sender = fullName + " <" + primaryAddress + ">"
    } else if (primaryAddress) {
      sender = primaryAddress
    }

    const outgoing = Mail.OutgoingMessage({
      subject: subject,
      content: body,
      sender: sender,
      visible: false,
    })

    Mail.outgoingMessages.push(outgoing)

    for (let i = 0; i < to.length; i++) {
      outgoing.toRecipients.push(Mail.Recipient({ address: to[i] }))
    }
    for (let i = 0; i < cc.length; i++) {
      outgoing.ccRecipients.push(Mail.Recipient({ address: cc[i] }))
    }
    for (let i = 0; i < bcc.length; i++) {
      outgoing.bccRecipients.push(Mail.Recipient({ address: bcc[i] }))
    }

    outgoing.send()

    return JSON.stringify({
      status: "sent",
      recipientCount: to.length + cc.length + bcc.length,
    })
  } catch (error) {
    return JSON.stringify({
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}
`

export const REPLY_EMAIL_JXA =
  MAILBOX_NAME_JXA +
  String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")

  try {
    const handle = input.handle || {}
    const accountId = typeof handle.accountId === "string" ? handle.accountId : ""
    const mailboxUrl = typeof handle.mailboxUrl === "string" ? handle.mailboxUrl : ""
    const mailId = typeof handle.mailId === "string" ? handle.mailId : ""
    const body = typeof input.body === "string" ? input.body : ""
    const replyAll = input.replyAll === true
    const fromAddress = typeof input.from === "string" ? input.from.trim() : ""
    const mailboxName = getMailboxName(mailboxUrl)

    if (!accountId || !mailId || !mailboxName) {
      return JSON.stringify({ status: "invalid_handle", detail: "Missing accountId, mailboxUrl, or mailId." })
    }

    const account = Mail.accounts.byId(accountId)
    if (typeof account.exists === "function" && !account.exists()) {
      return JSON.stringify({ status: "not_found", detail: "Account not found." })
    }

    const mailbox = account.mailboxes.byName(mailboxName)
    if (typeof mailbox.exists === "function" && !mailbox.exists()) {
      return JSON.stringify({ status: "not_found", detail: "Mailbox not found." })
    }

    const matchedMessage = mailbox.messages.byId(Number(mailId))
    if (typeof matchedMessage.exists === "function" && !matchedMessage.exists()) {
      return JSON.stringify({ status: "not_found", detail: "Message not found." })
    }

    const reply = matchedMessage.reply({ openingWindow: false, replyToAll: replyAll })

    if (body) {
      let existing = ""
      try { existing = reply.content() || "" } catch (_) {}
      reply.content = body + "\n\n" + existing
    }

    if (fromAddress) {
      reply.sender = fromAddress
    }

    reply.send()

    return JSON.stringify({ status: "sent" })
  } catch (error) {
    return JSON.stringify({
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}
`

export const FORWARD_EMAIL_JXA =
  MAILBOX_NAME_JXA +
  String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")

  try {
    const handle = input.handle || {}
    const accountId = typeof handle.accountId === "string" ? handle.accountId : ""
    const mailboxUrl = typeof handle.mailboxUrl === "string" ? handle.mailboxUrl : ""
    const mailId = typeof handle.mailId === "string" ? handle.mailId : ""
    const to = Array.isArray(input.to) ? input.to : []
    const cc = Array.isArray(input.cc) ? input.cc : []
    const bcc = Array.isArray(input.bcc) ? input.bcc : []
    const body = typeof input.body === "string" ? input.body : ""
    const fromAddress = typeof input.from === "string" ? input.from.trim() : ""
    const mailboxName = getMailboxName(mailboxUrl)

    if (!accountId || !mailId || !mailboxName) {
      return JSON.stringify({ status: "invalid_handle", detail: "Missing accountId, mailboxUrl, or mailId." })
    }

    if (to.length === 0) {
      return JSON.stringify({ status: "error", detail: "At least one 'to' recipient is required." })
    }

    const account = Mail.accounts.byId(accountId)
    if (typeof account.exists === "function" && !account.exists()) {
      return JSON.stringify({ status: "not_found", detail: "Account not found." })
    }

    const mailbox = account.mailboxes.byName(mailboxName)
    if (typeof mailbox.exists === "function" && !mailbox.exists()) {
      return JSON.stringify({ status: "not_found", detail: "Mailbox not found." })
    }

    const matchedMessage = mailbox.messages.byId(Number(mailId))
    if (typeof matchedMessage.exists === "function" && !matchedMessage.exists()) {
      return JSON.stringify({ status: "not_found", detail: "Message not found." })
    }

    const fwd = matchedMessage.forward({ openingWindow: false })

    if (body) {
      let existing = ""
      try { existing = fwd.content() || "" } catch (_) {}
      fwd.content = body + "\n\n" + existing
    }

    for (let i = 0; i < to.length; i++) {
      fwd.toRecipients.push(Mail.Recipient({ address: to[i] }))
    }
    for (let i = 0; i < cc.length; i++) {
      fwd.ccRecipients.push(Mail.Recipient({ address: cc[i] }))
    }
    for (let i = 0; i < bcc.length; i++) {
      fwd.bccRecipients.push(Mail.Recipient({ address: bcc[i] }))
    }

    if (fromAddress) {
      fwd.sender = fromAddress
    }

    fwd.send()

    return JSON.stringify({
      status: "sent",
      recipientCount: to.length + cc.length + bcc.length,
    })
  } catch (error) {
    return JSON.stringify({
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}
`
