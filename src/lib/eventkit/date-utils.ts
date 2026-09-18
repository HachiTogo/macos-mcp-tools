import { hasAllTags } from "./tags.js"
import type { Reminder } from "./types.js"

// --- Core date calculations ---

export function getTodayStart(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

export function getTomorrowStart(): Date {
  const today = getTodayStart()
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  return tomorrow
}

function getLocaleFirstDay(): number {
  try {
    const defaultLocale = Intl.DateTimeFormat().resolvedOptions().locale || "en-US"
    const locale = new Intl.Locale(defaultLocale)
    const weekInfo = (locale as Intl.Locale & { weekInfo?: { firstDay?: number } }).weekInfo
    if (weekInfo?.firstDay !== undefined) {
      return weekInfo.firstDay === 7 ? 0 : weekInfo.firstDay
    }
  } catch {
    // Fallback to Sunday
  }
  return 0
}

export function getWeekStart(): Date {
  const today = getTodayStart()
  const dayOfWeek = today.getDay()
  const firstDay = getLocaleFirstDay()
  const weekStart = new Date(today)
  weekStart.setDate(today.getDate() - ((dayOfWeek - firstDay + 7) % 7))
  return weekStart
}

export function getWeekEnd(): Date {
  const weekStart = getWeekStart()
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekStart.getDate() + 7)
  return weekEnd
}

export function getDateStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

// --- Reminder date parsing ---

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/
const DATE_ONLY_WITH_TZ_REGEX = /^(\d{4}-\d{2}-\d{2})(Z|[+-]\d{2}:?\d{2})$/i
const DATE_TIME_NO_TZ_REGEX = /^(\d{4}-\d{2}-\d{2})[ T]+(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/
const TIMEZONE_SUFFIX_REGEX = /(Z|[+-]\d{2}(?::?\d{2})?)$/i

const toNumber = (value: string): number => Number.parseInt(value, 10)

const createLocalDate = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date | undefined => {
  if ([year, month, day, hour, minute, second].some(Number.isNaN)) {
    return undefined
  }

  const date = new Date(year, month - 1, day, hour, minute, second, 0)

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return undefined
  }

  return date
}

const normalizeTimezoneSegment = (segment: string): string => {
  if (!segment) return segment
  if (segment === "Z" || segment === "z") return "Z"

  const clean = segment.replace(":", "").replace(" ", "")
  if (clean.length === 3) {
    return `${clean}:00`
  }
  if (clean.length === 5) {
    return `${clean.slice(0, 3)}:${clean.slice(3)}`
  }
  return segment.includes(":") ? segment : `${segment.slice(0, 3)}:${segment.slice(3)}`
}

const normalizeIsoString = (value: string): string => {
  let normalized = value.trim()
  if (normalized.includes(" ") && normalized.indexOf(" ") === 10) {
    normalized = `${normalized.slice(0, 10)}T${normalized.slice(11)}`
  }

  normalized = normalized.replace(TIMEZONE_SUFFIX_REGEX, (match) => normalizeTimezoneSegment(match))

  return normalized
}

const parseWithNative = (value: string): Date | undefined => {
  const normalized = normalizeIsoString(value)
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

export const parseReminderDueDate = (dueDate?: string | null): Date | undefined => {
  if (!dueDate) return undefined
  const trimmed = dueDate.trim()
  if (!trimmed) return undefined

  if (DATE_ONLY_REGEX.test(trimmed)) {
    const [year, month, day] = trimmed.split("-").map(toNumber)
    return createLocalDate(year, month, day)
  }

  const dateWithTzMatch = trimmed.match(DATE_ONLY_WITH_TZ_REGEX)
  if (dateWithTzMatch) {
    const [, datePart, tzSegment] = dateWithTzMatch
    return parseWithNative(`${datePart}T00:00:00${normalizeTimezoneSegment(tzSegment)}`)
  }

  const localDateTimeMatch = trimmed.match(DATE_TIME_NO_TZ_REGEX)
  if (localDateTimeMatch) {
    const [, datePart, hourStr, minuteStr, secondStr] = localDateTimeMatch
    const [year, month, day] = datePart.split("-").map(toNumber)
    const hour = toNumber(hourStr)
    const minute = toNumber(minuteStr)
    const second = secondStr ? toNumber(secondStr) : 0
    return createLocalDate(year, month, day, hour, minute, second)
  }

  if (TIMEZONE_SUFFIX_REGEX.test(trimmed)) {
    return parseWithNative(trimmed)
  }

  if (!/^[\d\-:T\s.Z+]+$/.test(trimmed)) {
    return undefined
  }

  return parseWithNative(trimmed)
}

// --- Date filtering ---

export type DateFilter = "today" | "tomorrow" | "this-week" | "overdue" | "no-date"

interface DateBoundaries {
  today: Date
  tomorrow: Date
  dayAfterTomorrow: Date
  weekStart: Date
  weekEnd: Date
}

function createDateBoundaries(): DateBoundaries {
  const today = getTodayStart()
  const tomorrow = getTomorrowStart()
  const dayAfterTomorrow = getTomorrowStart()
  dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1)
  const weekStart = getWeekStart()
  const weekEnd = getWeekEnd()

  return { today, tomorrow, dayAfterTomorrow, weekStart, weekEnd }
}

function filterRemindersByDate(reminders: Reminder[], filter: DateFilter): Reminder[] {
  if (filter === "no-date") {
    return reminders.filter((reminder) => !reminder.dueDate)
  }

  const { today, tomorrow, dayAfterTomorrow, weekStart, weekEnd } = createDateBoundaries()

  return reminders.filter((reminder) => {
    if (!reminder.dueDate) return false

    const dueDate = parseReminderDueDate(reminder.dueDate)
    if (!dueDate) return false

    switch (filter) {
      case "overdue":
        return dueDate.getTime() < today.getTime()

      case "today":
        return dueDate.getTime() >= today.getTime() && dueDate.getTime() < tomorrow.getTime()

      case "tomorrow":
        return dueDate.getTime() >= tomorrow.getTime() && dueDate.getTime() < dayAfterTomorrow.getTime()

      case "this-week":
        return dueDate.getTime() >= weekStart.getTime() && dueDate.getTime() < weekEnd.getTime()

      default:
        return true
    }
  })
}

export type PriorityFilter = "high" | "medium" | "low" | "none"

const PRIORITY_FILTER_MAP: Record<PriorityFilter, number> = {
  none: 0,
  high: 1,
  medium: 5,
  low: 9,
}

export interface ReminderFilters {
  showCompleted?: boolean
  search?: string
  dueWithin?: DateFilter
  list?: string
  priority?: PriorityFilter
  recurring?: boolean
  locationBased?: boolean
  tags?: string[]
}

export function applyReminderFilters(reminders: Reminder[], filters: ReminderFilters): Reminder[] {
  let filteredReminders = [...reminders]

  if (filters.showCompleted !== undefined) {
    filteredReminders = filteredReminders.filter((reminder) => filters.showCompleted || !reminder.isCompleted)
  }

  if (filters.list) {
    filteredReminders = filteredReminders.filter((reminder) => reminder.list === filters.list)
  }

  if (filters.search) {
    const searchLower = filters.search.toLowerCase()
    filteredReminders = filteredReminders.filter(
      (reminder) =>
        reminder.title.toLowerCase().includes(searchLower) || reminder.notes?.toLowerCase().includes(searchLower),
    )
  }

  if (filters.dueWithin) {
    filteredReminders = filterRemindersByDate(filteredReminders, filters.dueWithin)
  }

  if (filters.priority) {
    const priorityValue = PRIORITY_FILTER_MAP[filters.priority]
    filteredReminders = filteredReminders.filter((reminder) => reminder.priority === priorityValue)
  }

  if (filters.recurring !== undefined && filters.recurring) {
    filteredReminders = filteredReminders.filter((reminder) => (reminder.recurrenceRules?.length ?? 0) > 0)
  }

  if (filters.locationBased !== undefined && filters.locationBased) {
    filteredReminders = filteredReminders.filter((reminder) => reminder.locationTrigger !== undefined)
  }

  if (filters.tags && filters.tags.length > 0) {
    const { tags } = filters
    filteredReminders = filteredReminders.filter((reminder) => hasAllTags(reminder.tags, tags))
  }

  return filteredReminders
}
