import { describe, expect, test } from "bun:test"

import { formatForwardEmailSummary, formatReplyEmailSummary, formatSendEmailSummary, withWarnings } from "./format"

describe("withWarnings", () => {
  test("leaves a summary without warnings unchanged", () => {
    expect(withWarnings("Sent.", undefined)).toBe("Sent.")
    expect(withWarnings("Sent.", [])).toBe("Sent.")
  })

  test("lists each warning after the summary", () => {
    expect(withWarnings("Reply sent.", ["first", "second"])).toBe("Reply sent.\nWarnings:\n- first\n- second")
  })
})

describe("sent summaries", () => {
  test("show the warnings a send, reply or forward came back with", () => {
    const warnings = ["Could not read the sending account's name: Can't get object."]
    expect(formatSendEmailSummary({ status: "sent", recipientCount: 1, warnings })).toBe(
      "Sent: 1 recipient.\nWarnings:\n- Could not read the sending account's name: Can't get object.",
    )
    expect(formatReplyEmailSummary({ status: "sent", warnings })).toContain("\nWarnings:\n- Could not read")
    expect(formatForwardEmailSummary({ status: "sent", recipientCount: 2, warnings })).toContain(
      "Forward sent: 2 recipients.\nWarnings:",
    )
  })

  test("are unchanged when nothing fell back", () => {
    expect(formatSendEmailSummary({ status: "sent", recipientCount: 2 })).toBe("Sent: 2 recipients.")
    expect(formatReplyEmailSummary({ status: "sent" })).toBe("Reply sent.")
  })
})
