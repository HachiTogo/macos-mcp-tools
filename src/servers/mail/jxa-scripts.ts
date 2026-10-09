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

// Resolves an email handle to its Mail account, mailbox and message. Each script keeps its own
// result wording and the order it reports failures in; this only does the lookup, which ten scripts
// used to repeat.
export const MESSAGE_LOOKUP_JXA =
  MAILBOX_NAME_JXA +
  String.raw`
const INVALID_HANDLE_DETAIL = "Missing accountId, mailboxUrl, or mailId."
const MISSING_DETAIL = { account: "Account not found.", mailbox: "Mailbox not found.", message: "Message not found." }

const readHandle = (handle) => {
  const accountId = typeof handle.accountId === "string" ? handle.accountId : ""
  const mailboxUrl = typeof handle.mailboxUrl === "string" ? handle.mailboxUrl : ""
  const mailId = typeof handle.mailId === "string" ? handle.mailId : ""
  const mailboxName = getMailboxName(mailboxUrl)
  return { accountId, mailboxUrl, mailId, mailboxName, valid: Boolean(accountId && mailId && mailboxName) }
}

const exists = (specifier) => typeof specifier.exists !== "function" || specifier.exists()

// "missing" names the first of account, mailbox and message that does not exist.
const findMessage = (Mail, parts) => {
  const account = Mail.accounts.byId(parts.accountId)
  if (!exists(account)) return { missing: "account" }
  const mailbox = account.mailboxes.byName(parts.mailboxName)
  if (!exists(mailbox)) return { missing: "mailbox", account }
  const message = mailbox.messages.byId(Number(parts.mailId))
  if (!exists(message)) return { missing: "message", account, mailbox }
  return { account, mailbox, message }
}
`

export const MARK_EMAILS_READ_JXA =
  MESSAGE_LOOKUP_JXA +
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
      const parts = readHandle(target.handle || {})
      if (!parts.valid) {
        return { ...baseResult, status: "invalid_handle", detail: INVALID_HANDLE_DETAIL }
      }

      const found = findMessage(Mail, parts)
      if (found.missing) {
        return { ...baseResult, status: "not_found" }
      }
      const matchedMessage = found.message

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
  MESSAGE_LOOKUP_JXA +
  String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")
  const parts = readHandle(input.handle || {})
  if (!parts.accountId || !parts.mailId || !parts.mailboxUrl) {
    return JSON.stringify({ found: false, body: "" })
  }

  try {
    const found = findMessage(Mail, parts)
    if (found.missing) {
      return JSON.stringify({ found: false, body: "" })
    }
    const message = found.message
    const body = message.content() || ""
    return JSON.stringify({ found: true, body })
  } catch (error) {
    return JSON.stringify({ found: false, body: "", error: error instanceof Error ? error.message : String(error) })
  }
}
`

export const FETCH_EMAIL_SOURCE_JXA =
  MESSAGE_LOOKUP_JXA +
  String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")
  const parts = readHandle(input.handle || {})
  if (!parts.accountId || !parts.mailId || !parts.mailboxUrl) {
    return JSON.stringify({ found: false, source: "" })
  }

  try {
    const found = findMessage(Mail, parts)
    if (found.missing) {
      return JSON.stringify({ found: false, source: "" })
    }
    const message = found.message
    const source = message.source() || ""
    return JSON.stringify({ found: true, source })
  } catch (error) {
    return JSON.stringify({ found: false, source: "", error: error instanceof Error ? error.message : String(error) })
  }
}
`

export const LIST_EMAIL_ATTACHMENTS_JXA =
  MESSAGE_LOOKUP_JXA +
  String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")
  const parts = readHandle(input.handle || {})
  if (!parts.accountId || !parts.mailId || !parts.mailboxUrl) {
    return JSON.stringify({ found: false, attachments: [] })
  }

  try {
    const found = findMessage(Mail, parts)
    if (found.missing) {
      return JSON.stringify({ found: false, attachments: [] })
    }
    const message = found.message
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
  MESSAGE_LOOKUP_JXA +
  String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")
  const parts = readHandle(input.handle || {})
  const attachmentName = typeof input.attachmentName === "string" ? input.attachmentName : ""
  const savePath = typeof input.savePath === "string" ? input.savePath : ""

  if (!parts.accountId || !parts.mailId || !parts.mailboxUrl || !attachmentName || !savePath) {
    return JSON.stringify({ saved: false, error: "Missing required parameters." })
  }

  try {
    const found = findMessage(Mail, parts)
    if (found.missing) {
      return JSON.stringify({ saved: false, error: MISSING_DETAIL[found.missing] })
    }
    const message = found.message
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
  MESSAGE_LOOKUP_JXA +
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
      const parts = readHandle(target.handle || {})
      if (!parts.valid) {
        return { ...baseResult, status: "invalid_handle", detail: INVALID_HANDLE_DETAIL }
      }

      const found = findMessage(Mail, parts)
      if (found.missing === "account") {
        return { ...baseResult, status: "not_found", detail: MISSING_DETAIL.account }
      }

      const junkMailbox = findJunkMailbox(found.account)
      if (!junkMailbox) {
        return { ...baseResult, status: "no_junk_mailbox", detail: "No Junk or Spam mailbox found for this account." }
      }

      if (found.missing) {
        return { ...baseResult, status: "not_found", detail: MISSING_DETAIL[found.missing] }
      }
      const mailbox = found.mailbox
      const matchedMessage = found.message

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
  MESSAGE_LOOKUP_JXA +
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
      const parts = readHandle(target.handle || {})
      if (!parts.valid) {
        return { ...baseResult, status: "invalid_handle", detail: INVALID_HANDLE_DETAIL }
      }

      const found = findMessage(Mail, parts)
      if (found.missing === "account") {
        return { ...baseResult, status: "not_found", detail: MISSING_DETAIL.account }
      }

      const inboxMailbox = findInboxMailbox(found.account)
      if (!inboxMailbox) {
        return { ...baseResult, status: "no_inbox_mailbox", detail: "No Inbox mailbox found for this account." }
      }

      if (found.missing) {
        return { ...baseResult, status: "not_found", detail: MISSING_DETAIL[found.missing] }
      }
      const mailbox = found.mailbox
      const matchedMessage = found.message

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
  MESSAGE_LOOKUP_JXA +
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
      const parts = readHandle(target.handle || {})
      if (!parts.valid) {
        return { ...baseResult, status: "invalid_handle", detail: INVALID_HANDLE_DETAIL }
      }

      const found = findMessage(Mail, parts)
      if (found.missing) {
        return { ...baseResult, status: "not_found" }
      }
      const matchedMessage = found.message

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
// Reads an account detail that steers which account sends. A read that fails falls back as before
// (an account whose state cannot be read counts as enabled, with no addresses or name), and is
// recorded in warnings.
function readDetail(warnings, what, fallback, get) {
  try {
    return get()
  } catch (error) {
    warnings.push("Could not read " + what + ": " + (error instanceof Error ? error.message : String(error)))
    return fallback
  }
}

// The enabled account that owns fromAddress or, with no fromAddress, the first enabled account.
function chooseAccount(accounts, fromAddress, warnings) {
  const isEnabled = (acct, i) =>
    typeof acct.enabled !== "function" ||
    readDetail(warnings, "whether account " + (i + 1) + " is enabled", true, () => acct.enabled())
  if (!fromAddress) return accounts.find(isEnabled) || null
  const target = fromAddress.toLowerCase()
  for (let i = 0; i < accounts.length; i++) {
    const acct = accounts[i]
    if (!isEnabled(acct, i)) continue
    const addresses = readDetail(warnings, "account " + (i + 1) + "'s addresses", [], () => acct.emailAddresses() || [])
    if (addresses.some((addr) => typeof addr === "string" && addr.toLowerCase() === target)) return acct
  }
  return null
}

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
    const warnings = []
    const read = (what, fallback, get) => readDetail(warnings, what, fallback, get)
    const chosenAccount = chooseAccount(Mail.accounts(), fromAddress, warnings)

    if (!chosenAccount && fromAddress) {
      const reasons = warnings.length > 0 ? " (" + warnings.join("; ") + ")" : ""
      return JSON.stringify({ status: "error", detail: "No enabled account matches 'from' address: " + fromAddress + reasons })
    }
    if (!chosenAccount) {
      return JSON.stringify({ status: "error", detail: "No enabled mail account found." })
    }

    const addrs = read("the sending account's addresses", [], () => chosenAccount.emailAddresses() || [])
    const primaryAddress = fromAddress || (addrs.length > 0 ? addrs[0] : "")
    const fullName = read("the sending account's name", "", () => chosenAccount.fullName() || "")

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
      ...(warnings.length > 0 ? { warnings } : {}),
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
  MESSAGE_LOOKUP_JXA +
  String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")

  try {
    const parts = readHandle(input.handle || {})
    const body = typeof input.body === "string" ? input.body : ""
    const replyAll = input.replyAll === true
    const fromAddress = typeof input.from === "string" ? input.from.trim() : ""

    if (!parts.valid) {
      return JSON.stringify({ status: "invalid_handle", detail: INVALID_HANDLE_DETAIL })
    }

    const found = findMessage(Mail, parts)
    if (found.missing) {
      return JSON.stringify({ status: "not_found", detail: MISSING_DETAIL[found.missing] })
    }
    const matchedMessage = found.message

    const reply = matchedMessage.reply({ openingWindow: false, replyToAll: replyAll })

    const warnings = []
    if (body) {
      let existing = ""
      try {
        existing = reply.content() || ""
      } catch (error) {
        warnings.push("Could not read the original message to quote it, so it was sent without the quote: " + (error instanceof Error ? error.message : String(error)))
      }
      reply.content = body + "\n\n" + existing
    }

    if (fromAddress) {
      reply.sender = fromAddress
    }

    reply.send()

    return JSON.stringify({ status: "sent", ...(warnings.length > 0 ? { warnings } : {}) })
  } catch (error) {
    return JSON.stringify({
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}
`

export const FORWARD_EMAIL_JXA =
  MESSAGE_LOOKUP_JXA +
  String.raw`
function run(argv) {
  const Mail = Application("Mail")
  const input = JSON.parse(argv[0] || "{}")

  try {
    const parts = readHandle(input.handle || {})
    const to = Array.isArray(input.to) ? input.to : []
    const cc = Array.isArray(input.cc) ? input.cc : []
    const bcc = Array.isArray(input.bcc) ? input.bcc : []
    const body = typeof input.body === "string" ? input.body : ""
    const fromAddress = typeof input.from === "string" ? input.from.trim() : ""

    if (!parts.valid) {
      return JSON.stringify({ status: "invalid_handle", detail: INVALID_HANDLE_DETAIL })
    }

    if (to.length === 0) {
      return JSON.stringify({ status: "error", detail: "At least one 'to' recipient is required." })
    }

    const found = findMessage(Mail, parts)
    if (found.missing) {
      return JSON.stringify({ status: "not_found", detail: MISSING_DETAIL[found.missing] })
    }
    const matchedMessage = found.message

    const fwd = matchedMessage.forward({ openingWindow: false })

    const warnings = []
    if (body) {
      let existing = ""
      try {
        existing = fwd.content() || ""
      } catch (error) {
        warnings.push("Could not read the original message to quote it, so it was sent without the quote: " + (error instanceof Error ? error.message : String(error)))
      }
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
      ...(warnings.length > 0 ? { warnings } : {}),
    })
  } catch (error) {
    return JSON.stringify({
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}
`
