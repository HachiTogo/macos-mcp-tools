import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import {
  CreateCalendarEventSchema,
  calendarRepository,
  camelizeKeys,
  DeleteCalendarEventSchema,
  formatDeleteMessage,
  formatListMarkdown,
  formatMultilineNotes,
  formatSuccessMessage,
  handleAsyncOperation,
  ReadCalendarEventsSchema,
  UpdateCalendarEventSchema,
  validateToolArgs,
} from "../lib/eventkit/index.js"
import { offsetArg, paginate } from "../lib/paging"
import { PACKAGE_VERSION } from "../lib/version.js"

// ── Formatters ────────────────────────────────────────────────────────

export const formatEventMarkdown = (event: {
  title: string
  calendar?: string
  id?: string
  startDate?: string
  endDate?: string
  notes?: string
  location?: string
  structuredLocation?: { title: string; latitude?: number; longitude?: number }
  url?: string
  isAllDay?: boolean
  availability?: string
  alarms?: Array<{ relativeOffset?: number; absoluteDate?: string }>
  recurrenceRules?: Array<{ frequency: string; interval: number }>
  organizer?: { name?: string; url: string }
  attendees?: Array<{ name?: string; url: string }>
  status?: string
  isDetached?: boolean
  occurrenceDate?: string
  creationDate?: string
  lastModifiedDate?: string
  externalId?: string
}): string[] => {
  const lines: string[] = []
  lines.push(`- ${event.title}`)
  if (event.calendar) lines.push(`  - Calendar: ${event.calendar}`)
  if (event.id) lines.push(`  - ID: ${event.id}`)
  if (event.startDate) lines.push(`  - Start: ${event.startDate}`)
  if (event.endDate) lines.push(`  - End: ${event.endDate}`)
  if (event.isAllDay !== undefined) lines.push(`  - All Day: ${event.isAllDay}`)
  if (event.location) lines.push(`  - Location: ${event.location}`)
  if (event.structuredLocation) lines.push(`  - Structured Location: ${event.structuredLocation.title}`)
  if (event.availability) lines.push(`  - Availability: ${event.availability}`)
  if (event.alarms && event.alarms.length > 0) lines.push(`  - Alarms: ${event.alarms.length}`)
  if (event.recurrenceRules && event.recurrenceRules.length > 0)
    lines.push(`  - Recurrence Rules: ${event.recurrenceRules.length}`)
  if (event.organizer) lines.push(`  - Organizer: ${event.organizer.name ?? event.organizer.url}`)
  if (event.attendees && event.attendees.length > 0) lines.push(`  - Attendees: ${event.attendees.length}`)
  if (event.status) lines.push(`  - Status: ${event.status}`)
  if (event.isDetached !== undefined) lines.push(`  - Detached: ${event.isDetached}`)
  if (event.occurrenceDate) lines.push(`  - Occurrence Date: ${event.occurrenceDate}`)
  if (event.externalId) lines.push(`  - External ID: ${event.externalId}`)
  if (event.creationDate) lines.push(`  - Created: ${event.creationDate}`)
  if (event.lastModifiedDate) lines.push(`  - Modified: ${event.lastModifiedDate}`)
  if (event.notes) lines.push(`  - Notes: ${formatMultilineNotes(event.notes)}`)
  if (event.url) lines.push(`  - URL: ${event.url}`)
  return lines
}

// ── MCP Server ────────────────────────────────────────────────────────

const server = new McpServer({
  name: "apple-events",
  version: PACKAGE_VERSION,
})

// ── Argument schemas (snake_case; camelized for the EventKit validators) ──

const dateTime = (what: string) =>
  z.string().describe(`${what}: 'YYYY-MM-DD HH:mm:ss' in local time (recommended), or ISO 8601`)

const structuredLocation = z
  .object({
    title: z.string(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    radius: z.number().optional(),
  })
  .describe("Structured location with optional coordinates")

const alarms = z
  .array(
    z.object({
      relative_offset: z.number().optional().describe("Seconds from the start (negative = before)"),
      absolute_date: z.string().optional().describe("Absolute trigger date and time"),
      location_trigger: z
        .object({
          title: z.string(),
          latitude: z.number(),
          longitude: z.number(),
          radius: z.number().optional(),
          proximity: z.enum(["enter", "leave"]),
        })
        .optional(),
      alarm_type: z.enum(["display", "audio", "procedure", "email"]).optional().describe("Read-only presentation type"),
    }),
  )
  .describe("Alarms for the event")

const recurrenceRules = z
  .array(
    z.object({
      frequency: z.enum(["minutely", "hourly", "daily", "weekly", "monthly", "yearly"]),
      interval: z.number().int().optional().describe("Interval between occurrences (default 1)"),
      end_date: z.string().optional().describe("When the recurrence ends (YYYY-MM-DD)"),
      occurrence_count: z.number().int().optional().describe("Number of times to repeat"),
      days_of_week: z.array(z.number().int()).optional().describe("Days of week (1=Sunday, 7=Saturday)"),
      days_of_month: z.array(z.number().int()).optional().describe("Days of month (1-31)"),
      months_of_year: z.array(z.number().int()).optional().describe("Months for yearly recurrence (1-12)"),
    }),
  )
  .describe("Recurrence rules for a repeating event")

const availability = z
  .enum(["not-supported", "busy", "free", "tentative", "unavailable"])
  .describe("Event availability")
const span = z
  .enum(["this-event", "future-events"])
  .describe("For a recurring event: this occurrence or this and later ones")
const eventId = z
  .string()
  .min(1)
  .describe("Event id, as returned by list_events. A recurring event's id names the series.")

const eventFields = {
  note: z.string().optional().describe("Notes for the event"),
  location: z.string().optional().describe("Location text"),
  url: z.string().optional().describe("A URL for the event"),
  is_all_day: z.boolean().optional().describe("Whether it is an all-day event"),
  availability: availability.optional(),
  alarms: alarms.optional(),
  recurrence_rules: recurrenceRules.optional(),
}

const eventChanges = (
  validated: z.infer<typeof UpdateCalendarEventSchema> | z.infer<typeof CreateCalendarEventSchema>,
) => ({
  notes: validated.note,
  location: validated.location,
  url: validated.url,
  isAllDay: validated.isAllDay,
  availability: validated.availability,
  alarms: validated.alarms,
  recurrenceRules: validated.recurrenceRules,
})

server.registerTool(
  "list_events",
  {
    description:
      "List calendar events in a date range (the next 14 days by default), optionally filtered by calendar, account, text or availability.",
    inputSchema: {
      start_date: dateTime("Range start").optional(),
      end_date: dateTime("Range end").optional(),
      calendar: z.string().optional().describe("Only events in this calendar"),
      account: z.string().optional().describe("Only events in this account"),
      search: z.string().optional().describe("Text to match in title, notes or location"),
      availability: availability.optional(),
      limit: z.number().int().min(1).optional().describe("Return at most this many events (all by default)"),
      offset: offsetArg("events"),
    },
  },
  async (args) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs(
        {
          startDate: args.start_date,
          endDate: args.end_date,
          filterCalendar: args.calendar,
          filterAccount: args.account,
          search: args.search,
          availability: args.availability,
        },
        ReadCalendarEventsSchema,
      )
      const events = await calendarRepository.findEvents({
        startDate: validated.startDate,
        endDate: validated.endDate,
        calendarName: validated.filterCalendar,
        search: validated.search,
        availability: validated.availability,
        accountName: validated.filterAccount,
      })
      return formatListMarkdown(
        "Calendar Events",
        paginate(events, args.offset, args.limit),
        formatEventMarkdown,
        "No calendar events found.",
        { offset: args.offset, total: events.length },
      )
    }, "read calendar events"),
)

server.registerTool(
  "get_event",
  {
    description:
      "Get one calendar event by id, at any date. For a recurring event, returns its first occurrence. An event shared into two calendars has one id; the Calendar shown is the copy update_event and delete_event act on.",
    inputSchema: { id: eventId },
  },
  async ({ id }) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs({ id }, ReadCalendarEventsSchema)
      const event = await calendarRepository.findEventById(validated.id as string)
      return formatEventMarkdown(event).join("\n")
    }, "read calendar events"),
)

server.registerTool(
  "create_event",
  {
    description: "Create a calendar event.",
    inputSchema: {
      title: z.string().describe("Event title"),
      start_date: dateTime("Start"),
      end_date: dateTime("End"),
      calendar: z.string().optional().describe("Calendar to create it in (default calendar if omitted)"),
      structured_location: structuredLocation.optional(),
      ...eventFields,
    },
  },
  async ({ calendar, ...rest }) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs(
        { ...(camelizeKeys(rest) as object), targetCalendar: calendar },
        CreateCalendarEventSchema,
      )
      const event = await calendarRepository.createEvent({
        title: validated.title,
        startDate: validated.startDate,
        endDate: validated.endDate,
        calendar: validated.targetCalendar,
        structuredLocation: validated.structuredLocation,
        ...eventChanges(validated),
      })
      return formatSuccessMessage("created", "event", event.title, event.id)
    }, "create calendar event"),
)

server.registerTool(
  "update_event",
  {
    description: "Update a calendar event. Only the fields given change.",
    inputSchema: {
      id: eventId,
      title: z.string().optional().describe("New title"),
      start_date: dateTime("New start").optional(),
      end_date: dateTime("New end").optional(),
      calendar: z.string().optional().describe("Move the event to this calendar"),
      structured_location: structuredLocation.nullable().optional().describe("Structured location; null removes it"),
      ...eventFields,
      clear_alarms: z.boolean().optional().describe("Remove all alarms"),
      clear_recurrence: z.boolean().optional().describe("Remove the recurrence rules"),
      span: span.optional(),
    },
  },
  async ({ calendar, ...rest }) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs(
        { ...(camelizeKeys(rest) as object), targetCalendar: calendar },
        UpdateCalendarEventSchema,
      )
      const event = await calendarRepository.updateEvent({
        id: validated.id,
        title: validated.title,
        startDate: validated.startDate,
        endDate: validated.endDate,
        calendar: validated.targetCalendar,
        structuredLocation: validated.structuredLocation,
        ...eventChanges(validated),
        clearAlarms: validated.clearAlarms,
        clearRecurrence: validated.clearRecurrence,
        span: validated.span,
      })
      return formatSuccessMessage("updated", "event", event.title, event.id)
    }, "update calendar event"),
)

server.registerTool(
  "delete_event",
  {
    description: "Delete a calendar event, or for a recurring event one occurrence or this and later ones.",
    inputSchema: { id: eventId, span: span.optional() },
  },
  async ({ id, span }) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs({ id, span }, DeleteCalendarEventSchema)
      await calendarRepository.deleteEvent(validated.id, validated.span)
      return formatDeleteMessage("event", validated.id, {
        useQuotes: true,
        useIdPrefix: true,
        usePeriod: true,
        useColon: false,
      })
    }, "delete calendar event"),
)

server.registerTool(
  "list_calendars",
  {
    description: "List calendars, to choose one before creating or filtering events.",
    inputSchema: {},
  },
  async () =>
    handleAsyncOperation(async () => {
      const calendars = await calendarRepository.findAllCalendars()
      return formatListMarkdown(
        "Calendars",
        calendars,
        (calendar) => [`- ${calendar.title} (${calendar.account}) (ID: ${calendar.id})`],
        "No calendars found.",
      )
    }, "read calendars"),
)

// ── Entry point ───────────────────────────────────────────────────────

export const main = async () => {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// Boot only when executed directly; cli.ts and tests import this module without starting a server.
if (import.meta.main) {
  await main()
}
