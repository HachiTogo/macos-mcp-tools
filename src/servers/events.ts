import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  calendarRepository,
  extractAndValidateArgs,
  formatDeleteMessage,
  formatListMarkdown,
  formatMultilineNotes,
  formatSuccessMessage,
  handleAsyncOperation,
  CreateCalendarEventSchema,
  DeleteCalendarEventSchema,
  ReadCalendarEventsSchema,
  ReadCalendarsSchema,
  UpdateCalendarEventSchema,
} from "../lib/eventkit/index.js";
import type { CalendarToolArgs, CalendarsToolArgs } from "../lib/eventkit/index.js";

// ── Formatters ────────────────────────────────────────────────────────

const formatEventMarkdown = (event: {
  title: string;
  calendar?: string;
  id?: string;
  startDate?: string;
  endDate?: string;
  notes?: string;
  location?: string;
  structuredLocation?: { title: string; latitude?: number; longitude?: number };
  url?: string;
  isAllDay?: boolean;
  availability?: string;
  alarms?: Array<{ relativeOffset?: number; absoluteDate?: string }>;
  recurrenceRules?: Array<{ frequency: string; interval: number }>;
  organizer?: { name?: string; url: string };
  attendees?: Array<{ name?: string; url: string }>;
  status?: string;
  isDetached?: boolean;
  occurrenceDate?: string;
  creationDate?: string;
  lastModifiedDate?: string;
  externalId?: string;
}): string[] => {
  const lines: string[] = [];
  lines.push(`- ${event.title}`);
  if (event.calendar) lines.push(`  - Calendar: ${event.calendar}`);
  if (event.id) lines.push(`  - ID: ${event.id}`);
  if (event.startDate) lines.push(`  - Start: ${event.startDate}`);
  if (event.endDate) lines.push(`  - End: ${event.endDate}`);
  if (event.isAllDay !== undefined)
    lines.push(`  - All Day: ${event.isAllDay}`);
  if (event.location) lines.push(`  - Location: ${event.location}`);
  if (event.structuredLocation)
    lines.push(`  - Structured Location: ${event.structuredLocation.title}`);
  if (event.availability) lines.push(`  - Availability: ${event.availability}`);
  if (event.alarms && event.alarms.length > 0)
    lines.push(`  - Alarms: ${event.alarms.length}`);
  if (event.recurrenceRules && event.recurrenceRules.length > 0)
    lines.push(`  - Recurrence Rules: ${event.recurrenceRules.length}`);
  if (event.organizer)
    lines.push(`  - Organizer: ${event.organizer.name ?? event.organizer.url}`);
  if (event.attendees && event.attendees.length > 0)
    lines.push(`  - Attendees: ${event.attendees.length}`);
  if (event.status) lines.push(`  - Status: ${event.status}`);
  if (event.isDetached !== undefined)
    lines.push(`  - Detached: ${event.isDetached}`);
  if (event.occurrenceDate)
    lines.push(`  - Occurrence Date: ${event.occurrenceDate}`);
  if (event.externalId) lines.push(`  - External ID: ${event.externalId}`);
  if (event.creationDate) lines.push(`  - Created: ${event.creationDate}`);
  if (event.lastModifiedDate)
    lines.push(`  - Modified: ${event.lastModifiedDate}`);
  if (event.notes)
    lines.push(`  - Notes: ${formatMultilineNotes(event.notes)}`);
  if (event.url) lines.push(`  - URL: ${event.url}`);
  return lines;
};

// ── MCP Server ────────────────────────────────────────────────────────

const server = new McpServer({
  name: "apple-events",
  version: "0.0.1",
});

server.registerTool(
  "calendar_events",
  {
    description:
      "Manages calendar events (time blocks). Supports reading, creating, updating, and deleting calendar events.",
    inputSchema: {
      action: z.enum(["read", "create", "update", "delete"]).describe("The operation to perform"),
      id: z.string().optional().describe("The unique identifier of the event (REQUIRED for update, delete; optional for read to get single event)"),
      title: z.string().optional().describe("The title of the event (REQUIRED for create, optional for update)"),
      startDate: z.string().optional().describe("Start date and time. RECOMMENDED format: 'YYYY-MM-DD HH:mm:ss' (local time). Also supports ISO 8601"),
      endDate: z.string().optional().describe("End date and time. RECOMMENDED format: 'YYYY-MM-DD HH:mm:ss' (local time). Also supports ISO 8601"),
      note: z.string().optional().describe("Additional notes for the event"),
      location: z.string().optional().describe("Location text for the event"),
      structuredLocation: z
        .object({
          title: z.string(),
          latitude: z.number().optional(),
          longitude: z.number().optional(),
          radius: z.number().optional(),
        })
        .optional()
        .describe("Structured location with optional coordinates"),
      url: z.string().optional().describe("A URL to associate with the event"),
      isAllDay: z.boolean().optional().describe("Whether the event is an all-day event"),
      availability: z
        .enum(["not-supported", "busy", "free", "tentative", "unavailable"])
        .optional()
        .describe("Event availability"),
      alarms: z
        .array(
          z.object({
            relativeOffset: z.number().optional().describe("Seconds offset (negative = before start)"),
            absoluteDate: z.string().optional().describe("Absolute trigger date/time"),
            locationTrigger: z
              .object({
                title: z.string(),
                latitude: z.number(),
                longitude: z.number(),
                radius: z.number().optional(),
                proximity: z.enum(["enter", "leave"]),
              })
              .optional(),
            alarmType: z.enum(["display", "audio", "procedure", "email"]).optional().describe("READ-ONLY: Alarm presentation type"),
          }),
        )
        .optional()
        .describe("Alarms for the event"),
      clearAlarms: z.boolean().optional().describe("Set to true to remove all alarms from the event"),
      recurrenceRules: z
        .array(
          z.object({
            frequency: z.enum(["minutely", "hourly", "daily", "weekly", "monthly", "yearly"]),
            interval: z.number().int().optional().describe("Interval between occurrences (default 1)"),
            endDate: z.string().optional().describe("When the recurrence ends (YYYY-MM-DD)"),
            occurrenceCount: z.number().int().optional().describe("Number of times to repeat"),
            daysOfWeek: z.array(z.number().int()).optional().describe("Days of week (1=Sunday, 7=Saturday)"),
            daysOfMonth: z.array(z.number().int()).optional().describe("Days of month (1-31)"),
            monthsOfYear: z.array(z.number().int()).optional().describe("Months for yearly recurrence (1-12)"),
          }),
        )
        .optional()
        .describe("Recurrence rules for repeating events"),
      clearRecurrence: z.boolean().optional().describe("Set to true to remove recurrence rules from the event"),
      span: z
        .enum(["this-event", "future-events"])
        .optional()
        .describe("Scope for changes to recurring events"),
      targetCalendar: z.string().optional().describe("The name of the calendar for create or update operations"),
      filterCalendar: z.string().optional().describe("Filter events by a specific calendar name"),
      filterAccount: z.string().optional().describe("Filter events by account name"),
      search: z.string().optional().describe("Search term to filter events by title, notes, or location"),
    },
  },
  async (args) => {
    switch (args.action) {
      case "read":
        return handleAsyncOperation(async () => {
          const validatedArgs = extractAndValidateArgs(args as CalendarToolArgs, ReadCalendarEventsSchema);

          if (validatedArgs.id) {
            const event = await calendarRepository.findEventById(validatedArgs.id);
            return formatEventMarkdown(event).join("\n");
          }

          const events = await calendarRepository.findEvents({
            startDate: validatedArgs.startDate,
            endDate: validatedArgs.endDate,
            calendarName: validatedArgs.filterCalendar,
            search: validatedArgs.search,
            availability: validatedArgs.availability,
            accountName: validatedArgs.filterAccount,
          });

          return formatListMarkdown(
            "Calendar Events",
            events,
            formatEventMarkdown,
            "No calendar events found.",
          );
        }, "read calendar events");

      case "create":
        return handleAsyncOperation(async () => {
          const validatedArgs = extractAndValidateArgs(args as CalendarToolArgs, CreateCalendarEventSchema);
          const event = await calendarRepository.createEvent({
            title: validatedArgs.title,
            startDate: validatedArgs.startDate,
            endDate: validatedArgs.endDate,
            calendar: validatedArgs.targetCalendar,
            notes: validatedArgs.note,
            location: validatedArgs.location,
            structuredLocation: validatedArgs.structuredLocation,
            url: validatedArgs.url,
            isAllDay: validatedArgs.isAllDay,
            availability: validatedArgs.availability,
            alarms: validatedArgs.alarms,
            recurrenceRules: validatedArgs.recurrenceRules,
          });
          return formatSuccessMessage("created", "event", event.title, event.id);
        }, "create calendar event");

      case "update":
        return handleAsyncOperation(async () => {
          const validatedArgs = extractAndValidateArgs(args as CalendarToolArgs, UpdateCalendarEventSchema);
          const event = await calendarRepository.updateEvent({
            id: validatedArgs.id,
            title: validatedArgs.title,
            startDate: validatedArgs.startDate,
            endDate: validatedArgs.endDate,
            calendar: validatedArgs.targetCalendar,
            notes: validatedArgs.note,
            location: validatedArgs.location,
            structuredLocation: validatedArgs.structuredLocation,
            url: validatedArgs.url,
            isAllDay: validatedArgs.isAllDay,
            availability: validatedArgs.availability,
            alarms: validatedArgs.alarms,
            clearAlarms: validatedArgs.clearAlarms,
            recurrenceRules: validatedArgs.recurrenceRules,
            clearRecurrence: validatedArgs.clearRecurrence,
            span: validatedArgs.span,
          });
          return formatSuccessMessage("updated", "event", event.title, event.id);
        }, "update calendar event");

      case "delete":
        return handleAsyncOperation(async () => {
          const validatedArgs = extractAndValidateArgs(args as CalendarToolArgs, DeleteCalendarEventSchema);
          await calendarRepository.deleteEvent(validatedArgs.id, validatedArgs.span);
          return formatDeleteMessage("event", validatedArgs.id, {
            useQuotes: true,
            useIdPrefix: true,
            usePeriod: true,
            useColon: false,
          });
        }, "delete calendar event");

      default:
        return { content: [{ type: "text" as const, text: "Unknown action" }], isError: true };
    }
  },
);

server.registerTool(
  "calendar_calendars",
  {
    description:
      "Reads calendar collections. Use to inspect available calendars before creating or updating events.",
    inputSchema: {
      action: z.enum(["read"]).describe("The operation to perform on calendars"),
    },
  },
  async (args) => {
    return handleAsyncOperation(async () => {
      extractAndValidateArgs(args as CalendarsToolArgs, ReadCalendarsSchema);
      const calendars = await calendarRepository.findAllCalendars();
      return formatListMarkdown(
        "Calendars",
        calendars,
        (calendar) => [
          `- ${calendar.title} (${calendar.account}) (ID: ${calendar.id})`,
        ],
        "No calendars found.",
      );
    }, "read calendars");
  },
);

// ── Entry point ───────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
