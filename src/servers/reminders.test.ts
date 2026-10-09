import { describe, expect, test } from "bun:test"

import {
  combineSubtasksAndNotes,
  combineTagsAndNotes,
  extractTags,
  parseSubtasks,
  stripSubtasks,
  stripTags,
} from "../lib/eventkit/index.js"
import {
  formatAlarm,
  formatRecurrence,
  formatReminderMarkdown,
  formatSubtasksListMarkdown,
  rebuildNotesForUpdate,
} from "./reminders"

// Subtask ids are hex, as generateSubtaskId makes them; the notes parser ignores any other id.
const subtasks = [
  { id: "a1b2c3d4", title: "Buy flour", isCompleted: true },
  { id: "e5f6a7b8", title: "Bake", isCompleted: false },
]

describe("rebuildNotesForUpdate", () => {
  // Tags and subtasks live inside the reminder's notes, so every update has to keep them intact.
  const existing = combineSubtasksAndNotes(subtasks, combineTagsAndNotes(["home"], "Old note"))

  test("a new note replaces the text and keeps the tags and subtasks", () => {
    const notes = rebuildNotesForUpdate(existing, "New note", undefined, undefined, undefined)
    expect(stripSubtasks(stripTags(notes))).toBe("New note")
    expect(extractTags(notes)).toEqual(["home"])
    expect(parseSubtasks(notes).map((s) => s.title)).toEqual(["Buy flour", "Bake"])
  })

  test("adding and removing tags leaves the text and subtasks alone", () => {
    const notes = rebuildNotesForUpdate(existing, undefined, undefined, ["errand"], ["home"])
    expect(extractTags(notes)).toEqual(["errand"])
    expect(stripSubtasks(stripTags(notes))).toBe("Old note")
    expect(parseSubtasks(notes)).toHaveLength(2)
  })

  test("a full tag list replaces the old tags", () => {
    expect(extractTags(rebuildNotesForUpdate(existing, undefined, ["a", "b"], undefined, undefined))).toEqual([
      "a",
      "b",
    ])
  })
})

describe("formatRecurrence", () => {
  test("names the frequency, interval, days and end", () => {
    expect(formatRecurrence({ frequency: "daily", interval: 1 })).toBe("day")
    expect(formatRecurrence({ frequency: "weekly", interval: 2, daysOfWeek: [2, 4] })).toBe("every 2 weeks on Mon, Wed")
    expect(formatRecurrence({ frequency: "monthly", interval: 1, daysOfMonth: [1, 15] })).toBe("month on days 1, 15")
    expect(formatRecurrence({ frequency: "yearly", interval: 1, monthsOfYear: [12], endDate: "2027-01-01" })).toBe(
      "year in Dec until 2027-01-01",
    )
    expect(formatRecurrence({ frequency: "hourly", interval: 3, occurrenceCount: 4 })).toBe("every 3 hours (4 times)")
  })
})

describe("formatAlarm", () => {
  test("describes absolute, relative and location alarms", () => {
    expect(formatAlarm({ absoluteDate: "2026-10-10 09:00:00" })).toBe("at 2026-10-10 09:00:00")
    expect(formatAlarm({ relativeOffset: -900, alarmType: "display" })).toBe("-900s from due/start (display)")
    expect(
      formatAlarm({ locationTrigger: { title: "Home", latitude: 0, longitude: 0, proximity: "enter", radius: 100 } }),
    ).toBe('on Arriving at "Home" (100m radius)')
    expect(formatAlarm({})).toBe("unknown")
  })
})

describe("formatReminderMarkdown", () => {
  test("shows the checkbox, priority, tags and subtasks, and hides the markup in notes", () => {
    const notes = combineSubtasksAndNotes(subtasks, combineTagsAndNotes(["home"], "Bring the recipe"))
    const lines = formatReminderMarkdown({
      title: "Bread",
      isCompleted: false,
      list: "Errands",
      priority: 1,
      tags: ["home"],
      subtasks,
      subtaskProgress: { completed: 1, total: 2, percentage: 50 },
      notes,
    })
    expect(lines[0]).toStartWith("- [ ] Bread ")
    expect(lines).toContain("  - List: Errands")
    expect(lines).toContain("  - Priority: high (1)")
    expect(lines).toContain("  - Tags: #home")
    expect(lines).toContain("  - Subtasks (1/2):")
    expect(lines).toContain("    - [x] Buy flour")
    expect(lines).toContain("  - Notes: Bring the recipe")
  })
})

describe("formatSubtasksListMarkdown", () => {
  test("numbers the subtasks under a progress line", () => {
    expect(formatSubtasksListMarkdown("Bread", subtasks)).toBe(
      '### Subtasks for "Bread"\n\n**Progress:** 1/2 (50%)\n\n1. [x] Buy flour (ID: a1b2c3d4)\n2. [ ] Bake (ID: e5f6a7b8)',
    )
    expect(formatSubtasksListMarkdown("Empty", [])).toContain("No subtasks found.")
  })
})
