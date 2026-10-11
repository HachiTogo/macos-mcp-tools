import { describe, expect, test } from "bun:test"

import { calendarsOutput, eventOutput, eventsOutput, formatEventMarkdown, structuredEvent } from "./events"

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

describe("structured results", () => {
  const event = {
    id: "E1",
    title: "Run club",
    startDate: "2026-10-10T07:00:00-07:00",
    endDate: "2026-10-10T08:00:00-07:00",
    calendar: "Home",
    notes: "Bring water",
    isAllDay: false,
    recurrenceRules: [{ frequency: "weekly" as const, interval: 1, daysOfWeek: [7] }],
    alarms: [{ relativeOffset: -900, alarmType: "display" as const }],
    attendees: [
      { url: "mailto:a@example.com", status: "accepted", role: "required", type: "person", isCurrentUser: true },
    ],
  }

  test("an event comes back in the arguments' casing, with notes as note", () => {
    const structured = structuredEvent(event)
    expect(structured).toMatchObject({
      start_date: event.startDate,
      is_all_day: false,
      note: "Bring water",
      recurrence_rules: [{ frequency: "weekly", interval: 1, days_of_week: [7] }],
      alarms: [{ relative_offset: -900, alarm_type: "display" }],
    })
    expect(structured).not.toHaveProperty("notes")
  })

  test("each read result matches its tool's declared output schema", () => {
    expect(eventsOutput.parse({ events: [structuredEvent(event)], total: 1, offset: 0 })).toBeTruthy()
    expect(eventsOutput.parse({ events: [], total: 0, offset: 5 })).toBeTruthy()
    expect(eventOutput.parse({ event: structuredEvent(event) })).toBeTruthy()
    const calendars = [{ id: "C1", title: "Home", account: "iCloud", account_type: "calDAV" }]
    expect(calendarsOutput.parse({ calendars })).toBeTruthy()
  })
})
