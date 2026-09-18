export type ReminderPriority = 0 | 1 | 2 | 3

export const PRIORITY_LABELS: Record<number, string> = {
  0: "none",
  1: "high",
  2: "medium",
  3: "low",
}

export type RecurrenceFrequency = "minutely" | "hourly" | "daily" | "weekly" | "monthly" | "yearly"

export interface RecurrenceRule {
  frequency: RecurrenceFrequency
  interval: number
  endDate?: string
  occurrenceCount?: number
  daysOfWeek?: number[]
  daysOfMonth?: number[]
  monthsOfYear?: number[]
}

export type LocationProximity = "enter" | "leave"

export interface LocationTrigger {
  title: string
  latitude: number
  longitude: number
  radius?: number
  proximity: LocationProximity
}

export interface StructuredLocation {
  title: string
  latitude?: number
  longitude?: number
  radius?: number
}

export interface Alarm {
  relativeOffset?: number
  absoluteDate?: string
  locationTrigger?: LocationTrigger
  alarmType?: "display" | "audio" | "procedure" | "email"
}

export interface Subtask {
  id: string
  title: string
  isCompleted: boolean
}

export interface SubtaskProgress {
  completed: number
  total: number
  percentage: number
}

export interface Reminder {
  id: string
  title: string
  startDate?: string
  dueDate?: string
  completionDate?: string
  notes?: string
  url?: string
  location?: string
  timeZone?: string
  creationDate?: string
  lastModifiedDate?: string
  externalId?: string
  list: string
  isCompleted: boolean
  priority: number
  alarms?: Alarm[]
  recurrenceRules?: RecurrenceRule[]
  locationTrigger?: LocationTrigger
  tags?: string[]
  subtasks?: Subtask[]
  subtaskProgress?: SubtaskProgress
}

export interface ReminderList {
  id: string
  title: string
  color?: string
}

export interface CalendarEvent {
  id: string
  title: string
  startDate: string
  endDate: string
  calendar: string
  notes?: string
  location?: string
  structuredLocation?: StructuredLocation
  url?: string
  isAllDay: boolean
  availability?: "not-supported" | "busy" | "free" | "tentative" | "unavailable" | "unknown"
  alarms?: Alarm[]
  recurrenceRules?: RecurrenceRule[]
  organizer?: { name?: string; url: string }
  attendees?: Array<{
    name?: string
    url: string
    status: string
    role: string
    type: string
    isCurrentUser: boolean
  }>
  status?: string
  isDetached?: boolean
  occurrenceDate?: string
  creationDate?: string
  lastModifiedDate?: string
  externalId?: string
}

export interface Calendar {
  id: string
  title: string
  account: string
  accountType: string
}

export type ReminderAction = "read" | "create" | "update" | "delete"
export type ListAction = "read" | "create" | "update" | "delete"
export type CalendarAction = "read" | "create" | "update" | "delete"
export type CalendarsAction = "read"
export type DueWithinOption = "today" | "tomorrow" | "this-week" | "overdue" | "no-date"

export const REMINDER_ACTIONS: readonly ReminderAction[] = ["read", "create", "update", "delete"] as const

export const LIST_ACTIONS: readonly ListAction[] = ["read", "create", "update", "delete"] as const

export const CALENDAR_ACTIONS: readonly CalendarAction[] = ["read", "create", "update", "delete"] as const

export const DUE_WITHIN_OPTIONS: readonly DueWithinOption[] = [
  "today",
  "tomorrow",
  "this-week",
  "overdue",
  "no-date",
] as const

interface BaseToolArgs {
  action: string
}

export interface RemindersToolArgs extends BaseToolArgs {
  action: ReminderAction
  id?: string
  filterList?: string
  showCompleted?: boolean
  search?: string
  dueWithin?: DueWithinOption
  filterPriority?: "high" | "medium" | "low" | "none"
  filterRecurring?: boolean
  filterLocationBased?: boolean
  filterTags?: string[]
  title?: string
  newTitle?: string
  startDate?: string
  dueDate?: string
  note?: string
  url?: string
  location?: string
  completed?: boolean
  completionDate?: string
  priority?: number
  alarms?: Alarm[]
  clearAlarms?: boolean
  recurrenceRules?: RecurrenceRule[]
  clearRecurrence?: boolean
  locationTrigger?: LocationTrigger
  clearLocationTrigger?: boolean
  tags?: string[]
  addTags?: string[]
  removeTags?: string[]
  subtasks?: string[]
  targetList?: string
}

export type SubtaskAction = "read" | "create" | "update" | "delete" | "toggle" | "reorder"

export interface SubtasksToolArgs extends BaseToolArgs {
  action: SubtaskAction
  reminderId: string
  subtaskId?: string
  title?: string
  completed?: boolean
  order?: string[]
}

export interface ListsToolArgs extends BaseToolArgs {
  action: ListAction
  name?: string
  newName?: string
  color?: string
}

export interface CalendarToolArgs extends BaseToolArgs {
  action: CalendarAction
  id?: string
  filterCalendar?: string
  filterAccount?: string
  search?: string
  availability?: "not-supported" | "busy" | "free" | "tentative" | "unavailable"
  startDate?: string
  endDate?: string
  title?: string
  note?: string
  location?: string
  structuredLocation?: StructuredLocation
  url?: string
  isAllDay?: boolean
  alarms?: Alarm[]
  clearAlarms?: boolean
  recurrenceRules?: RecurrenceRule[]
  clearRecurrence?: boolean
  span?: "this-event" | "future-events"
  targetCalendar?: string
}

export interface CalendarsToolArgs extends BaseToolArgs {
  action: CalendarsAction
}

// JSON repository interfaces

export interface RecurrenceRuleJSON {
  frequency: "minutely" | "hourly" | "daily" | "weekly" | "monthly" | "yearly"
  interval?: number
  endDate?: string | null
  occurrenceCount?: number | null
  daysOfWeek?: number[] | null
  daysOfMonth?: number[] | null
  monthsOfYear?: number[] | null
}

export interface LocationTriggerJSON {
  title: string
  latitude: number
  longitude: number
  radius?: number
  proximity: "enter" | "leave" | "none"
}

export interface StructuredLocationJSON {
  title: string
  latitude?: number | null
  longitude?: number | null
  radius?: number | null
}

export interface AlarmJSON {
  relativeOffset?: number | null
  absoluteDate?: string | null
  locationTrigger?: LocationTriggerJSON | null
  alarmType?: string | null
}

export interface ParticipantJSON {
  name?: string | null
  url: string
  status?: string | null
  role?: string | null
  type?: string | null
  isCurrentUser?: boolean | null
}

export interface ReminderJSON {
  id: string
  title: string
  isCompleted: boolean
  list: string
  notes: string | null
  url: string | null
  location?: string | null
  timeZone?: string | null
  dueDate: string | null
  startDate?: string | null
  completionDate?: string | null
  creationDate?: string | null
  lastModifiedDate?: string | null
  externalId?: string | null
  priority: number
  alarms?: AlarmJSON[] | null
  recurrenceRules?: RecurrenceRuleJSON[] | null
  locationTrigger: LocationTriggerJSON | null
}

export interface ListJSON {
  id: string
  title: string
  color?: string | null
}

export interface EventJSON {
  id: string
  title: string
  calendar: string
  startDate: string
  endDate: string
  notes: string | null
  location: string | null
  structuredLocation?: StructuredLocationJSON | null
  url: string | null
  isAllDay: boolean
  availability?: string | null
  alarms?: AlarmJSON[] | null
  recurrenceRules?: RecurrenceRuleJSON[] | null
  organizer?: ParticipantJSON | null
  attendees?: ParticipantJSON[] | null
  status?: string | null
  isDetached?: boolean | null
  occurrenceDate?: string | null
  creationDate?: string | null
  lastModifiedDate?: string | null
  externalId?: string | null
}

export interface CalendarJSON {
  id: string
  title: string
  account: string
  accountType: string
}

export interface ReminderReadResult {
  lists: ListJSON[]
  reminders: ReminderJSON[]
}

export interface EventsReadResult {
  calendars: CalendarJSON[]
  events: EventJSON[]
}

export interface CreateReminderData {
  title: string
  list?: string
  notes?: string
  url?: string
  location?: string
  startDate?: string
  dueDate?: string
  priority?: number
  isCompleted?: boolean
  completionDate?: string
  alarms?: AlarmJSON[]
  recurrenceRules?: RecurrenceRuleJSON[]
  locationTrigger?: LocationTriggerJSON
}

export interface UpdateReminderData {
  id: string
  newTitle?: string
  list?: string
  notes?: string
  url?: string
  location?: string
  isCompleted?: boolean
  completionDate?: string
  startDate?: string
  dueDate?: string
  priority?: number
  alarms?: AlarmJSON[]
  clearAlarms?: boolean
  recurrenceRules?: RecurrenceRuleJSON[]
  clearRecurrence?: boolean
  locationTrigger?: LocationTriggerJSON
  clearLocationTrigger?: boolean
}

export interface CreateEventData {
  title: string
  startDate: string
  endDate: string
  calendar?: string
  notes?: string
  location?: string
  structuredLocation?: StructuredLocationJSON
  url?: string
  isAllDay?: boolean
  availability?: string
  alarms?: AlarmJSON[]
  recurrenceRules?: RecurrenceRuleJSON[]
}

export interface UpdateEventData {
  id: string
  title?: string
  startDate?: string
  endDate?: string
  calendar?: string
  notes?: string
  location?: string
  structuredLocation?: StructuredLocationJSON | null
  url?: string
  isAllDay?: boolean
  availability?: string
  alarms?: AlarmJSON[]
  clearAlarms?: boolean
  recurrenceRules?: RecurrenceRuleJSON[]
  clearRecurrence?: boolean
  span?: "this-event" | "future-events"
}
