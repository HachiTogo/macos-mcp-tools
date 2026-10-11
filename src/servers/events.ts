import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { CREATE, DESTRUCTIVE, READ } from "../lib/annotations"
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
import { serve } from "../lib/serve"
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

// Field descriptions are kept for what a name and type cannot say. The date format is stated once,
// in each tool's description.
const DATES = "Dates are local 'YYYY-MM-DD HH:mm:ss' or ISO 8601."
const date = z.string()

const structuredLocation = z.object({
  title: z.string(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  radius: z.number().optional(),
})

const alarms = z.array(
  z.object({
    relative_offset: z.number().optional().describe("Seconds from the start; negative is before"),
    absolute_date: date.optional(),
    location_trigger: z
      .object({
        title: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        radius: z.number().optional(),
        proximity: z.enum(["enter", "leave"]),
      })
      .optional(),
  }),
)

const recurrenceRules = z.array(
  z.object({
    frequency: z.enum(["minutely", "hourly", "daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().optional(),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
    occurrence_count: z.number().int().optional(),
    days_of_week: z.array(z.number().int()).optional().describe("1 is Sunday, 7 Saturday"),
    days_of_month: z.array(z.number().int()).optional(),
    months_of_year: z.array(z.number().int()).optional(),
  }),
)

const availability = z.enum(["not-supported", "busy", "free", "tentative", "unavailable"])
const span = z.enum(["this-event", "future-events"]).describe("Recurring events; default this-event")
const eventId = z.string().min(1).describe("From list_events; a recurring event's id names the series")

const eventFields = {
  note: z.string().optional(),
  location: z.string().optional(),
  url: z.string().optional(),
  is_all_day: z.boolean().optional(),
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
    description: `List events from start_date to end_date (default: the next 14 days). ${DATES}`,
    inputSchema: {
      start_date: date.optional(),
      end_date: date.optional(),
      calendar: z.string().optional().describe("Title or id from list_calendars"),
      account: z.string().optional().describe("As list_calendars shows it"),
      search: z.string().optional().describe("Matches title, notes or location"),
      availability: availability.optional(),
      limit: z.number().int().min(1).optional().describe("Default: all"),
      offset: offsetArg("events"),
    },
    annotations: READ,
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
      "Get an event by id, at any date; a recurring event gives its first occurrence. An event shared into two calendars has one id, and the calendar shown is the copy update_event and delete_event change.",
    inputSchema: { id: eventId },
    annotations: READ,
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
    description: `Create an event. ${DATES}`,
    inputSchema: {
      title: z.string(),
      start_date: date,
      end_date: date,
      calendar: z.string().optional().describe("Title or id; default calendar if omitted"),
      structured_location: structuredLocation.optional(),
      ...eventFields,
    },
    annotations: CREATE,
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
    description: `Update an event; only the fields given change. ${DATES}`,
    inputSchema: {
      id: eventId,
      title: z.string().optional(),
      start_date: date.optional(),
      end_date: date.optional(),
      calendar: z.string().optional().describe("Move to this calendar (title or id)"),
      structured_location: structuredLocation.nullable().optional().describe("null removes it"),
      ...eventFields,
      clear_alarms: z.boolean().optional(),
      clear_recurrence: z.boolean().optional(),
      span: span.optional(),
    },
    annotations: DESTRUCTIVE,
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
    description: "Delete an event; for a recurring one, span picks this occurrence or this and later ones.",
    inputSchema: { id: eventId, span: span.optional() },
    annotations: DESTRUCTIVE,
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
    description: "List calendars with their ids and accounts.",
    inputSchema: {},
    annotations: READ,
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

export const main = () => serve(server)

// Boot only when executed directly; cli.ts and tests import this module without starting a server.
if (import.meta.main) {
  await main()
}
