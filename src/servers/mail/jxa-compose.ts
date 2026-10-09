// The scripts that compose and send mail: send_email, reply_email and forward_email. They run in
// Mail.app through osascript; reply and forward find their original with the shared message lookup.

import { MESSAGE_LOOKUP_JXA } from "./jxa-scripts"

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
