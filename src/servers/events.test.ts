import { describe, expect, test } from "bun:test"

import { formatEventMarkdown } from "./events"

describe("formatEventMarkdown", () => {
  test("a bare event is just its title", () => {
    expect(formatEventMarkdown({ title: "Standup" })).toEqual(["- Standup"])
  })

  test("lists the fields an event has, counting alarms, rules and attendees", () => {
    const lines = formatEventMarkdown({
      title: "Planning",
      calendar: "Work",
      id: "E1",
      startDate: "2026-10-10T09:00:00-07:00",
      endDate: "2026-10-10T10:00:00-07:00",
      isAllDay: false,
      location: "Room 4",
      alarms: [{ relativeOffset: -600 }, { relativeOffset: -60 }],
      recurrenceRules: [{ frequency: "weekly", interval: 1 }],
      organizer: { url: "mailto:lead@example.com" },
      attendees: [{ url: "mailto:a@example.com" }, { name: "B", url: "mailto:b@example.com" }],
      notes: "Agenda\nfirst item",
    })
    expect(lines).toEqual([
      "- Planning",
      "  - Calendar: Work",
      "  - ID: E1",
      "  - Start: 2026-10-10T09:00:00-07:00",
      "  - End: 2026-10-10T10:00:00-07:00",
      "  - All Day: false",
      "  - Location: Room 4",
      "  - Alarms: 2",
      "  - Recurrence Rules: 1",
      "  - Organizer: mailto:lead@example.com",
      "  - Attendees: 2",
      "  - Notes: Agenda\n    first item",
    ])
  })
})
