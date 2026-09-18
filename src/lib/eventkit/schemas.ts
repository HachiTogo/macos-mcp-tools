import { z } from "zod"
import { VALIDATION } from "./constants.js"

const SAFE_TEXT_PATTERN = /^[\u0020-\u007E\u00A0-\u2029\u202F-\u2065\u206A-\uFFFF\n\r\t]*$/u

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}.*$/

const URL_PATTERN =
  /^https?:\/\/(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*|\[[0-9a-fA-F:]+\])(?::\d+)?(?:\/[^\s<>"{}|\\^`[\]]*)?$/i

function isBlockedHostname(hostname: string): boolean {
  const lowerHostname = hostname.toLowerCase()

  const blockedHostnames = ["localhost", "localhost.localdomain", "local", "internal", "metadata.google.internal"]
  if (blockedHostnames.includes(lowerHostname)) {
    return true
  }

  if (/^\d+$/.test(lowerHostname)) {
    const decimal = parseInt(lowerHostname, 10)
    if (!Number.isNaN(decimal) && decimal > 0 && decimal <= 4294967295) {
      const a = (decimal >>> 24) & 255
      const b = (decimal >>> 16) & 255
      const c = (decimal >>> 8) & 255
      const d = decimal & 255
      if (isBlockedIPv4(a, b, c, d)) return true
    }
  }

  if (/^0x[0-9a-f]+$/i.test(lowerHostname)) {
    const hex = parseInt(lowerHostname, 16)
    if (!Number.isNaN(hex) && hex > 0 && hex <= 4294967295) {
      const a = (hex >>> 24) & 255
      const b = (hex >>> 16) & 255
      const c = (hex >>> 8) & 255
      const d = hex & 255
      if (isBlockedIPv4(a, b, c, d)) return true
    }
  }

  const octalPattern = /^0[0-7]*(?:\.[0-7]+){0,3}$/
  if (octalPattern.test(lowerHostname)) {
    const parts = lowerHostname.split(".").map((p) => parseInt(p, 8))
    if (parts.length === 4 && parts.every((p) => !Number.isNaN(p) && p >= 0 && p <= 255)) {
      if (isBlockedIPv4(parts[0], parts[1], parts[2], parts[3])) return true
    }
  }

  const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d+)?$/
  const ipv4Match = lowerHostname.match(ipv4Pattern)
  if (ipv4Match) {
    const [, a, b, c, d] = ipv4Match.map(Number)
    if (isBlockedIPv4(a, b, c, d)) return true
  }

  const ipv6Hostname = lowerHostname.replace(/^\[|\]$/g, "")
  if (ipv6Hostname === "::1" || ipv6Hostname === "0:0:0:0:0:0:0:1") return true
  if (ipv6Hostname === "::" || ipv6Hostname === "0:0:0:0:0:0:0:0") return true
  if (/^fe[89ab][0-9a-f]:/i.test(ipv6Hostname)) return true
  if (/^fc[0-9a-f][0-9a-f]:/i.test(ipv6Hostname) || /^fd[0-9a-f][0-9a-f]:/i.test(ipv6Hostname)) return true
  if (/^ff[0-9a-f][0-9a-f]:/i.test(ipv6Hostname)) return true
  if (/^2001:db8:/i.test(ipv6Hostname)) return true

  return false
}

function isBlockedIPv4(a: number, b: number, c: number, d: number): boolean {
  if (a < 0 || a > 255 || b < 0 || b > 255 || c < 0 || c > 255 || d < 0 || d > 255) {
    return false
  }
  if (a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b === 100 && c === 100 && d === 200) return true
  if (a === 0) return true
  if (a >= 224 && a <= 239) return true
  if (a >= 240) return true
  return false
}

function createSafeTextSchema(minLength: number, maxLength: number, fieldName?: string, optional?: false): z.ZodString
function createSafeTextSchema(
  minLength: number,
  maxLength: number,
  fieldName: string,
  optional: true,
): z.ZodOptional<z.ZodString>
function createSafeTextSchema(
  minLength: number,
  maxLength: number,
  fieldName = "Text",
  optional = false,
): z.ZodString | z.ZodOptional<z.ZodString> {
  let schema = z
    .string()
    .max(maxLength, `${fieldName} cannot exceed ${maxLength} characters`)
    .regex(
      SAFE_TEXT_PATTERN,
      `${fieldName} contains invalid characters. Only alphanumeric, spaces, and basic punctuation allowed`,
    )

  if (minLength > 0) {
    schema = schema.min(minLength, `${fieldName} cannot be empty`)
  }

  return optional ? schema.optional() : schema
}

export const SafeTextSchema = createSafeTextSchema(1, VALIDATION.MAX_TITLE_LENGTH)
export const SafeNoteSchema = createSafeTextSchema(0, VALIDATION.MAX_NOTE_LENGTH, "Note", true)
export const SafeListNameSchema = createSafeTextSchema(0, VALIDATION.MAX_LIST_NAME_LENGTH, "List name", true)
export const RequiredListNameSchema = createSafeTextSchema(1, VALIDATION.MAX_LIST_NAME_LENGTH, "List name")
export const SafeSearchSchema = createSafeTextSchema(0, VALIDATION.MAX_SEARCH_LENGTH, "Search term", true)

export const SafeDateSchema = z
  .string()
  .regex(
    DATE_PATTERN,
    "Date must be in format 'YYYY-MM-DD', 'YYYY-MM-DD HH:mm:ss', or ISO 8601 (e.g., '2025-10-30T04:00:00Z')",
  )
  .optional()

const createRequiredDateSchema = (fieldName: string) =>
  z
    .string()
    .regex(DATE_PATTERN, `${fieldName} must be in format 'YYYY-MM-DD', 'YYYY-MM-DD HH:mm:ss', or ISO 8601`)
    .min(1, `${fieldName} is required`)

export const SafeUrlSchema = z
  .string()
  .regex(URL_PATTERN, "URL must be a valid HTTP or HTTPS URL")
  .max(VALIDATION.MAX_URL_LENGTH, `URL cannot exceed ${VALIDATION.MAX_URL_LENGTH} characters`)
  .refine((url) => {
    try {
      const parsed = new URL(url)
      return !isBlockedHostname(parsed.hostname)
    } catch {
      return false
    }
  }, "URL must not point to internal, private, or blocked addresses")
  .optional()

const DueWithinEnum = z.enum(["today", "tomorrow", "this-week", "overdue", "no-date"]).optional()

const PriorityFilterEnum = z.enum(["high", "medium", "low", "none"]).optional()

const PriorityValueSchema = z
  .number()
  .int()
  .refine((val) => [0, 1, 5, 9].includes(val), {
    message: "Priority must be 0 (none), 1 (high), 5 (medium), or 9 (low)",
  })
  .optional()

const RecurrenceRuleObjectSchema = z.object({
  frequency: z.enum(["minutely", "hourly", "daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().positive().default(1),
  endDate: SafeDateSchema,
  occurrenceCount: z.number().int().positive().optional(),
  daysOfWeek: z
    .array(z.number().int().min(1).max(7))
    .optional()
    .refine((arr: number[] | undefined) => !arr || arr.length <= 7, {
      message: "daysOfWeek cannot have more than 7 entries",
    }),
  daysOfMonth: z
    .array(z.number().int().min(1).max(31))
    .optional()
    .refine((arr: number[] | undefined) => !arr || arr.length <= 31, {
      message: "daysOfMonth cannot have more than 31 entries",
    }),
  monthsOfYear: z
    .array(z.number().int().min(1).max(12))
    .optional()
    .refine((arr: number[] | undefined) => !arr || arr.length <= 12, {
      message: "monthsOfYear cannot have more than 12 entries",
    }),
})

const RecurrenceRuleSchema = RecurrenceRuleObjectSchema.optional()

const RecurrenceRulesSchema = z.array(RecurrenceRuleObjectSchema).optional()

const LocationTriggerObjectSchema = z.object({
  title: createSafeTextSchema(1, VALIDATION.MAX_TITLE_LENGTH, "Location title"),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radius: z.number().positive().default(100),
  proximity: z.enum(["enter", "leave"]),
})

const LocationTriggerSchema = LocationTriggerObjectSchema.optional()

const StructuredLocationSchema = z
  .object({
    title: createSafeTextSchema(1, VALIDATION.MAX_TITLE_LENGTH, "Location title"),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    radius: z.number().positive().optional(),
  })
  .optional()

const AlarmTypeSchema = z.enum(["display", "audio", "procedure", "email"]).optional()

const AlarmSchema = z
  .object({
    relativeOffset: z.number().finite().optional(),
    absoluteDate: SafeDateSchema,
    locationTrigger: LocationTriggerObjectSchema.optional(),
    alarmType: AlarmTypeSchema,
  })
  .refine(
    (alarm) =>
      [alarm.relativeOffset, alarm.absoluteDate, alarm.locationTrigger].filter((value) => value !== undefined)
        .length === 1,
    {
      message: "Alarm must specify exactly one of relativeOffset, absoluteDate, or locationTrigger",
    },
  )

const AlarmArraySchema = z.array(AlarmSchema).optional()

const AvailabilitySchema = z.enum(["not-supported", "busy", "free", "tentative", "unavailable"]).optional()

const SpanSchema = z.enum(["this-event", "future-events"]).optional()

const TagSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^#?[a-zA-Z0-9_-]+$/, {
    message: "Tags can only contain letters, numbers, underscores, and hyphens",
  })

const TagArraySchema = z.array(TagSchema).optional()

const SubtaskTitleSchema = createSafeTextSchema(1, VALIDATION.MAX_TITLE_LENGTH, "Subtask title")

const SubtaskTitleArraySchema = z.array(SubtaskTitleSchema).optional()

const BaseReminderFields = {
  title: SafeTextSchema,
  startDate: SafeDateSchema,
  dueDate: SafeDateSchema,
  note: SafeNoteSchema,
  url: SafeUrlSchema,
  location: createSafeTextSchema(0, VALIDATION.MAX_LOCATION_LENGTH, "Location", true),
  targetList: SafeListNameSchema,
  priority: PriorityValueSchema,
  completed: z.boolean().optional(),
  alarms: AlarmArraySchema,
  clearAlarms: z.boolean().optional(),
  recurrenceRules: RecurrenceRulesSchema,
  recurrence: RecurrenceRuleSchema,
  locationTrigger: LocationTriggerSchema,
  tags: TagArraySchema,
  subtasks: SubtaskTitleArraySchema,
}

export const SafeIdSchema = z.string().min(1, "ID cannot be empty")

export const CreateReminderSchema = z.object(BaseReminderFields)

export const ReadRemindersSchema = z.object({
  id: SafeIdSchema.optional(),
  filterList: SafeListNameSchema,
  showCompleted: z.boolean().optional().default(false),
  search: SafeSearchSchema,
  dueWithin: DueWithinEnum,
  filterPriority: PriorityFilterEnum,
  filterRecurring: z.boolean().optional(),
  filterLocationBased: z.boolean().optional(),
  filterTags: TagArraySchema,
})

export const UpdateReminderSchema = z.object({
  id: SafeIdSchema,
  title: SafeTextSchema.optional(),
  startDate: SafeDateSchema,
  dueDate: SafeDateSchema,
  note: SafeNoteSchema,
  url: SafeUrlSchema,
  location: createSafeTextSchema(0, VALIDATION.MAX_LOCATION_LENGTH, "Location", true),
  completed: z.boolean().optional(),
  completionDate: SafeDateSchema,
  targetList: SafeListNameSchema,
  priority: PriorityValueSchema,
  alarms: AlarmArraySchema,
  clearAlarms: z.boolean().optional(),
  recurrenceRules: RecurrenceRulesSchema,
  recurrence: RecurrenceRuleSchema,
  clearRecurrence: z.boolean().optional(),
  locationTrigger: LocationTriggerSchema,
  clearLocationTrigger: z.boolean().optional(),
  tags: TagArraySchema,
  addTags: TagArraySchema,
  removeTags: TagArraySchema,
})

export const DeleteReminderSchema = z.object({
  id: SafeIdSchema,
})

export const CreateCalendarEventSchema = z.object({
  title: SafeTextSchema,
  startDate: createRequiredDateSchema("Start date"),
  endDate: createRequiredDateSchema("End date"),
  note: SafeNoteSchema,
  location: createSafeTextSchema(0, VALIDATION.MAX_LOCATION_LENGTH, "Location", true),
  structuredLocation: StructuredLocationSchema,
  url: SafeUrlSchema,
  isAllDay: z.boolean().optional(),
  availability: AvailabilitySchema,
  alarms: AlarmArraySchema,
  recurrenceRules: RecurrenceRulesSchema,
  targetCalendar: SafeListNameSchema,
})

export const ReadCalendarEventsSchema = z.object({
  id: SafeIdSchema.optional(),
  filterCalendar: SafeListNameSchema,
  filterAccount: SafeListNameSchema,
  search: SafeSearchSchema,
  availability: AvailabilitySchema,
  startDate: SafeDateSchema,
  endDate: SafeDateSchema,
})

export const UpdateCalendarEventSchema = z.object({
  id: SafeIdSchema,
  title: SafeTextSchema.optional(),
  startDate: SafeDateSchema,
  endDate: SafeDateSchema,
  note: SafeNoteSchema,
  location: createSafeTextSchema(0, VALIDATION.MAX_LOCATION_LENGTH, "Location", true),
  structuredLocation: StructuredLocationSchema.nullable(),
  url: SafeUrlSchema,
  isAllDay: z.boolean().optional(),
  availability: AvailabilitySchema,
  alarms: AlarmArraySchema,
  clearAlarms: z.boolean().optional(),
  recurrenceRules: RecurrenceRulesSchema,
  clearRecurrence: z.boolean().optional(),
  span: SpanSchema,
  targetCalendar: SafeListNameSchema,
})

export const DeleteCalendarEventSchema = z.object({
  id: SafeIdSchema,
  span: SpanSchema,
})

export const ReadCalendarsSchema = z.object({})

export const CreateReminderListSchema = z.object({
  name: RequiredListNameSchema,
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, {
      message: 'Color must be a valid hex code (e.g., "#FF5733")',
    })
    .optional(),
})

export const UpdateReminderListSchema = z
  .object({
    name: RequiredListNameSchema,
    newName: SafeListNameSchema,
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, {
        message: 'Color must be a valid hex code (e.g., "#FF5733")',
      })
      .optional(),
  })
  .refine((data) => data.newName || data.color, {
    message: "At least one of newName or color must be provided",
  })

export const DeleteReminderListSchema = z.object({
  name: RequiredListNameSchema,
})

export class ValidationError extends Error {
  constructor(
    message: string,
    public details?: Record<string, string[]>,
  ) {
    super(message)
    this.name = "ValidationError"
  }
}

export const validateInput = <T>(schema: z.ZodType<T>, input: unknown): T => {
  try {
    return schema.parse(input)
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues.map((err) => `${err.path.join(".")}: ${err.message}`).join("; ")

      const errorDetails = error.issues.reduce<Record<string, string[]>>((acc, err) => {
        const path = err.path.join(".")
        acc[path] = acc[path] ?? []
        acc[path].push(err.message)
        return acc
      }, {})

      throw new ValidationError(`Input validation failed: ${errorMessages}`, errorDetails)
    }

    throw new ValidationError("Input validation failed: Unknown error")
  }
}

const SubtaskIdSchema = z
  .string()
  .min(1, "Subtask ID is required")
  .regex(/^[a-f0-9]+$/, "Subtask ID must be a valid hex string")

const SubtaskOrderSchema = z.array(SubtaskIdSchema).min(1, "Order array cannot be empty")

export const ReadSubtasksSchema = z.object({
  reminderId: SafeIdSchema,
})

export const CreateSubtaskSchema = z.object({
  reminderId: SafeIdSchema,
  title: SubtaskTitleSchema,
})

export const UpdateSubtaskSchema = z.object({
  reminderId: SafeIdSchema,
  subtaskId: SubtaskIdSchema,
  title: SubtaskTitleSchema.optional(),
  completed: z.boolean().optional(),
})

export const DeleteSubtaskSchema = z.object({
  reminderId: SafeIdSchema,
  subtaskId: SubtaskIdSchema,
})

export const ToggleSubtaskSchema = z.object({
  reminderId: SafeIdSchema,
  subtaskId: SubtaskIdSchema,
})

export const ReorderSubtasksSchema = z.object({
  reminderId: SafeIdSchema,
  order: SubtaskOrderSchema,
})

export {
  AlarmArraySchema,
  AlarmSchema,
  AvailabilitySchema,
  LocationTriggerObjectSchema,
  RecurrenceRuleObjectSchema,
  RecurrenceRulesSchema,
  SpanSchema,
  StructuredLocationSchema,
  TagArraySchema,
}
