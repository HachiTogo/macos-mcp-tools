// The reminders server's pure helpers: keeping tags and subtasks when an update rewrites a reminder's
// notes, and the markdown the tools return for reminders, lists and subtasks.

import type { Alarm, LocationTrigger, RecurrenceRule, Subtask } from "../../lib/eventkit/index.js"
import {
  addTagsToNotes,
  combineSubtasksAndNotes,
  combineTagsAndNotes,
  extractTags,
  formatMultilineNotes,
  getSubtaskProgress,
  PRIORITY_LABELS,
  parseSubtasks,
  removeTagsFromNotes,
  stripSubtasks,
  stripTags,
} from "../../lib/eventkit/index.js"

// ── Helpers ───────────────────────────────────────────────────────────

export function rebuildNotesForUpdate(
  currentNotes: string | undefined,
  newNote: string | undefined,
  tags: string[] | undefined,
  addTags: string[] | undefined,
  removeTags: string[] | undefined,
): string {
  const existingNotes = currentNotes ?? ""
  const existingSubtasks = parseSubtasks(existingNotes)
  const notesWithoutSubtasks = stripSubtasks(existingNotes)

  let notesWithTags = notesWithoutSubtasks

  if (addTags && addTags.length > 0) {
    notesWithTags = addTagsToNotes(addTags, notesWithTags)
  }

  if (removeTags && removeTags.length > 0) {
    notesWithTags = removeTagsFromNotes(removeTags, notesWithTags)
  }

  if (tags) {
    const baseNote = newNote !== undefined ? stripSubtasks(stripTags(newNote)) : stripTags(notesWithoutSubtasks)
    notesWithTags = combineTagsAndNotes(tags, baseNote)
  } else if (newNote !== undefined) {
    const cleanNewNote = stripSubtasks(stripTags(newNote))
    const tagsFromExisting = extractTags(notesWithTags)
    notesWithTags = combineTagsAndNotes(tagsFromExisting, cleanNewNote)
  }

  return combineSubtasksAndNotes(existingSubtasks, notesWithTags)
}

// ── Reminder formatters ───────────────────────────────────────────────

export const formatRecurrence = (recurrence: RecurrenceRule): string => {
  const parts: string[] = []
  const interval = recurrence.interval > 1 ? `every ${recurrence.interval} ` : ""

  switch (recurrence.frequency) {
    case "minutely":
      parts.push(`${interval}minute${recurrence.interval > 1 ? "s" : ""}`)
      break
    case "hourly":
      parts.push(`${interval}hour${recurrence.interval > 1 ? "s" : ""}`)
      break
    case "daily":
      parts.push(`${interval}day${recurrence.interval > 1 ? "s" : ""}`)
      break
    case "weekly":
      parts.push(`${interval}week${recurrence.interval > 1 ? "s" : ""}`)
      if (recurrence.daysOfWeek?.length) {
        const dayNames = ["", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        const days = recurrence.daysOfWeek.map((d) => dayNames[d]).join(", ")
        parts.push(`on ${days}`)
      }
      break
    case "monthly":
      parts.push(`${interval}month${recurrence.interval > 1 ? "s" : ""}`)
      if (recurrence.daysOfMonth?.length) {
        parts.push(`on day${recurrence.daysOfMonth.length > 1 ? "s" : ""} ${recurrence.daysOfMonth.join(", ")}`)
      }
      break
    case "yearly":
      parts.push(`${interval}year${recurrence.interval > 1 ? "s" : ""}`)
      if (recurrence.monthsOfYear?.length) {
        const monthNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        const months = recurrence.monthsOfYear.map((m) => monthNames[m]).join(", ")
        parts.push(`in ${months}`)
      }
      break
    default: {
      const exhaustiveCheck: never = recurrence.frequency
      throw new Error(`Unknown recurrence frequency: ${exhaustiveCheck}`)
    }
  }

  if (recurrence.endDate) {
    parts.push(`until ${recurrence.endDate}`)
  } else if (recurrence.occurrenceCount) {
    parts.push(`(${recurrence.occurrenceCount} times)`)
  }

  return parts.join(" ")
}

const formatRecurrenceRules = (rules: RecurrenceRule[]): string => {
  if (rules.length === 1) return formatRecurrence(rules[0])
  return rules.map((rule) => formatRecurrence(rule)).join("; ")
}

export const formatAlarm = (alarm: Alarm): string => {
  let typeStr = ""
  if (alarm.alarmType) {
    typeStr = ` (${alarm.alarmType})`
  }
  if (alarm.absoluteDate) return `at ${alarm.absoluteDate}${typeStr}`
  if (alarm.relativeOffset !== undefined) return `${alarm.relativeOffset}s from due/start${typeStr}`
  if (alarm.locationTrigger) return `on ${formatLocationTrigger(alarm.locationTrigger)}${typeStr}`
  return "unknown"
}

const formatLocationTrigger = (location: LocationTrigger): string => {
  const proximityText = location.proximity === "enter" ? "Arriving at" : "Leaving"
  const radiusText = location.radius ? ` (${location.radius}m radius)` : ""
  return `${proximityText} "${location.title}"${radiusText}`
}

const buildReminderIcons = (reminder: {
  recurrence?: RecurrenceRule
  recurrenceRules?: RecurrenceRule[]
  locationTrigger?: LocationTrigger
  tags?: string[]
  subtasks?: Subtask[]
}): string => {
  const icons: string[] = []
  if (reminder.recurrenceRules && reminder.recurrenceRules.length > 0) icons.push("\u{1F504}")
  if (reminder.locationTrigger) icons.push("\u{1F4CD}")
  if (reminder.tags && reminder.tags.length > 0) icons.push("\u{1F3F7}️")
  if (reminder.subtasks && reminder.subtasks.length > 0) icons.push("\u{1F4CB}")
  return icons.length > 0 ? ` ${icons.join("")}` : ""
}

export const formatReminderMarkdown = (reminder: {
  title: string
  isCompleted: boolean
  list?: string
  id?: string
  notes?: string
  dueDate?: string
  url?: string
  location?: string
  priority?: number
  recurrence?: RecurrenceRule
  recurrenceRules?: RecurrenceRule[]
  locationTrigger?: LocationTrigger
  alarms?: Alarm[]
  completionDate?: string
  startDate?: string
  creationDate?: string
  lastModifiedDate?: string
  externalId?: string
  tags?: string[]
  subtasks?: Subtask[]
  subtaskProgress?: { completed: number; total: number; percentage: number }
}): string[] => {
  const lines: string[] = []
  const checkbox = reminder.isCompleted ? "[x]" : "[ ]"
  const icons = buildReminderIcons(reminder)
  lines.push(`- ${checkbox} ${reminder.title}${icons}`)
  if (reminder.list) lines.push(`  - List: ${reminder.list}`)
  if (reminder.id) lines.push(`  - ID: ${reminder.id}`)
  if (reminder.priority !== undefined) {
    const priorityLabel = PRIORITY_LABELS[reminder.priority] ?? "unknown"
    lines.push(`  - Priority: ${priorityLabel} (${reminder.priority})`)
  }
  if (reminder.startDate) lines.push(`  - Start: ${reminder.startDate}`)
  if (reminder.tags && reminder.tags.length > 0) {
    lines.push(`  - Tags: ${reminder.tags.map((t) => `#${t}`).join(" ")}`)
  }
  const recurrenceRules = reminder.recurrenceRules ?? (reminder.recurrence ? [reminder.recurrence] : undefined)
  if (recurrenceRules && recurrenceRules.length > 0) {
    lines.push(`  - Repeats: ${formatRecurrenceRules(recurrenceRules)}`)
  }
  if (reminder.locationTrigger) {
    lines.push(`  - Location: ${formatLocationTrigger(reminder.locationTrigger)}`)
  }
  if (reminder.location) lines.push(`  - Location Text: ${reminder.location}`)
  if (reminder.alarms && reminder.alarms.length > 0) {
    lines.push(`  - Alarms: ${reminder.alarms.map(formatAlarm).join("; ")}`)
  }
  if (reminder.subtasks && reminder.subtasks.length > 0) {
    const progress = reminder.subtaskProgress
    const progressText = progress ? ` (${progress.completed}/${progress.total})` : ""
    lines.push(`  - Subtasks${progressText}:`)
    for (const subtask of reminder.subtasks) {
      const subtaskCheckbox = subtask.isCompleted ? "[x]" : "[ ]"
      lines.push(`    - ${subtaskCheckbox} ${subtask.title}`)
    }
  }
  const cleanNotes = stripSubtasks(stripTags(reminder.notes))
  if (cleanNotes) {
    lines.push(`  - Notes: ${formatMultilineNotes(cleanNotes)}`)
  }
  if (reminder.dueDate) lines.push(`  - Due: ${reminder.dueDate}`)
  if (reminder.completionDate) lines.push(`  - Completed: ${reminder.completionDate}`)
  if (reminder.url) lines.push(`  - URL: ${reminder.url}`)
  if (reminder.externalId) lines.push(`  - External ID: ${reminder.externalId}`)
  if (reminder.creationDate) lines.push(`  - Created: ${reminder.creationDate}`)
  if (reminder.lastModifiedDate) lines.push(`  - Modified: ${reminder.lastModifiedDate}`)
  return lines
}

// ── List formatter ────────────────────────────────────────────────────

export const formatReminderList = (list: { title: string; id: string; color?: string }): string[] => {
  let display = list.title
  if (list.color) {
    display = `${display} (Color: ${list.color})`
  }
  return [`- ${display} (ID: ${list.id})`]
}

// ── Subtask formatters ────────────────────────────────────────────────

const formatSubtaskMarkdown = (subtask: Subtask, index: number): string => {
  const checkbox = subtask.isCompleted ? "[x]" : "[ ]"
  return `${index + 1}. ${checkbox} ${subtask.title} (ID: ${subtask.id})`
}

export const formatSubtasksListMarkdown = (reminderTitle: string, subtasks: Subtask[]): string => {
  const lines: string[] = []
  const progress = getSubtaskProgress(subtasks)

  lines.push(`### Subtasks for "${reminderTitle}"`)
  lines.push("")
  lines.push(`**Progress:** ${progress.completed}/${progress.total} (${progress.percentage}%)`)
  lines.push("")

  if (subtasks.length === 0) {
    lines.push("No subtasks found.")
  } else {
    subtasks.forEach((subtask, index) => {
      lines.push(formatSubtaskMarkdown(subtask, index))
    })
  }

  return lines.join("\n")
}
