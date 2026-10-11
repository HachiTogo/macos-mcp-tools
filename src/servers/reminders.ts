import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import {
  addSubtask,
  CreateReminderListSchema,
  CreateReminderSchema,
  CreateSubtaskSchema,
  camelizeKeys,
  combineSubtasksAndNotes,
  combineTagsAndNotes,
  createSubtasksFromTitles,
  DeleteReminderListSchema,
  DeleteReminderSchema,
  DeleteSubtaskSchema,
  formatDeleteMessage,
  formatListMarkdown,
  formatSuccessMessage,
  handleAsyncOperation,
  parseSubtasks,
  ReadRemindersSchema,
  ReadSubtasksSchema,
  ReorderSubtasksSchema,
  reminderRepository,
  removeSubtask,
  reorderSubtasks,
  ToggleSubtaskSchema,
  toggleSubtask,
  UpdateReminderListSchema,
  UpdateReminderSchema,
  UpdateSubtaskSchema,
  updateSubtask,
  validateToolArgs,
} from "../lib/eventkit/index.js"
import { offsetArg, paginate } from "../lib/paging"
import { PACKAGE_VERSION } from "../lib/version.js"

import {
  formatReminderList,
  formatReminderMarkdown,
  formatSubtasksListMarkdown,
  rebuildNotesForUpdate,
} from "./reminders/format.js"

// ── MCP Server ────────────────────────────────────────────────────────

const server = new McpServer({
  name: "apple-reminders",
  version: PACKAGE_VERSION,
})

// ── Argument schemas (snake_case; camelized for the EventKit validators) ──

const dateTime = (what: string) =>
  z.string().describe(`${what}: 'YYYY-MM-DD HH:mm:ss' in local time (recommended), or ISO 8601`)

const locationTrigger = z
  .object({
    title: z.string().describe("Location name"),
    latitude: z.number(),
    longitude: z.number(),
    radius: z.number().optional().describe("Geofence radius in meters (default 100)"),
    proximity: z.enum(["enter", "leave"]).describe("Trigger on arriving or leaving"),
  })
  .describe("Location trigger for a geofenced reminder")

const alarms = z
  .array(
    z.object({
      relative_offset: z.number().optional().describe("Seconds from the due or start date (negative = before)"),
      absolute_date: z.string().optional().describe("Absolute trigger date and time"),
      location_trigger: locationTrigger.optional(),
      alarm_type: z.enum(["display", "audio", "procedure", "email"]).optional().describe("Read-only presentation type"),
    }),
  )
  .describe("Alarms for the reminder")

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
  .describe("Recurrence rules for a repeating reminder")

const reminderId = z.string().min(1).describe("Reminder id, as returned by list_reminders")
const subtaskId = z.string().min(1).describe("Subtask id, as returned by list_subtasks")
const listName = z.string().min(1).describe("Reminder list name or id, as returned by list_reminder_lists")
const priority = z.number().int().describe("Priority: 0 none, 1 high, 5 medium, 9 low")

const reminderFields = {
  start_date: dateTime("Start").optional(),
  due_date: dateTime("Due").optional(),
  note: z.string().optional().describe("Notes"),
  location: z.string().optional().describe("Location text (not a location trigger)"),
  url: z.string().optional().describe("A URL for the reminder"),
  priority: priority.optional(),
  alarms: alarms.optional(),
  recurrence_rules: recurrenceRules.optional(),
  location_trigger: locationTrigger.optional(),
}

/** Snake_case tool arguments as the camelCase object the EventKit schemas validate. */
const camel = (args: object, renames: Record<string, string> = {}) => {
  const out = camelizeKeys(args) as Record<string, unknown>
  for (const [from, to] of Object.entries(renames)) {
    if (from in out) {
      out[to] = out[from]
      delete out[from]
    }
  }
  return out
}

// ── Reminders ─────────────────────────────────────────────────────────

server.registerTool(
  "list_reminders",
  {
    description:
      "List reminders, incomplete ones by default, optionally filtered by list, text, due date, priority, recurrence, location or tags.",
    inputSchema: {
      list: z.string().optional().describe("Only reminders in this list (name or id from list_reminder_lists)"),
      show_completed: z.boolean().optional().describe("Include completed reminders"),
      search: z.string().optional().describe("Text to match in title or notes"),
      due_within: z
        .enum(["today", "tomorrow", "this-week", "overdue", "no-date"])
        .optional()
        .describe("Due date range"),
      priority: z.enum(["high", "medium", "low", "none"]).optional().describe("Only this priority"),
      recurring: z.boolean().optional().describe("Only recurring reminders"),
      location_based: z.boolean().optional().describe("Only location-based reminders"),
      tags: z.array(z.string()).optional().describe("Only reminders with all of these tags"),
      limit: z.number().int().min(1).optional().describe("Return at most this many reminders"),
      offset: offsetArg("reminders"),
    },
  },
  async ({ limit, offset, ...filters }) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs(
        camel(filters, {
          list: "filterList",
          priority: "filterPriority",
          recurring: "filterRecurring",
          locationBased: "filterLocationBased",
          tags: "filterTags",
        }),
        ReadRemindersSchema,
      )
      const reminders = await reminderRepository.findReminders({
        list: validated.filterList,
        showCompleted: validated.showCompleted,
        search: validated.search,
        dueWithin: validated.dueWithin,
        priority: validated.filterPriority,
        recurring: validated.filterRecurring,
        locationBased: validated.filterLocationBased,
        tags: validated.filterTags,
      })
      return formatListMarkdown(
        "Reminders",
        paginate(reminders, offset, limit),
        formatReminderMarkdown,
        "No reminders found matching the criteria.",
        { offset, total: reminders.length },
      )
    }, "read reminders"),
)

server.registerTool(
  "get_reminder",
  { description: "Get one reminder by id.", inputSchema: { id: reminderId } },
  async ({ id }) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs({ id }, ReadRemindersSchema)
      const reminder = await reminderRepository.findReminderById(validated.id as string)
      return ["### Reminder", "", ...formatReminderMarkdown(reminder)].join("\n")
    }, "read reminders"),
)

server.registerTool(
  "create_reminder",
  {
    description: "Create a reminder, optionally with tags and initial subtasks.",
    inputSchema: {
      title: z.string().describe("Reminder title"),
      list: z.string().optional().describe("List to create it in, by name or id (default list if omitted)"),
      ...reminderFields,
      completed: z.boolean().optional().describe("Create it already completed"),
      tags: z.array(z.string()).optional().describe("Tags to set"),
      subtasks: z.array(z.string()).optional().describe("Titles of initial subtasks"),
    },
  },
  async (args) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs(camel(args, { list: "targetList" }), CreateReminderSchema)
      let notes = validated.tags ? combineTagsAndNotes(validated.tags, validated.note) : validated.note
      if (validated.subtasks && validated.subtasks.length > 0) {
        notes = combineSubtasksAndNotes(createSubtasksFromTitles(validated.subtasks), notes)
      }
      const reminder = await reminderRepository.createReminder({
        title: validated.title,
        notes,
        url: validated.url,
        location: validated.location,
        list: validated.targetList,
        startDate: validated.startDate,
        dueDate: validated.dueDate,
        priority: validated.priority,
        isCompleted: validated.completed,
        alarms: validated.alarms,
        recurrenceRules: validated.recurrenceRules,
        locationTrigger: validated.locationTrigger,
      })
      return formatSuccessMessage("created", "reminder", reminder.title, reminder.id)
    }, "create reminder"),
)

server.registerTool(
  "update_reminder",
  {
    description: "Update a reminder. Only the fields given change; tags and subtasks in its notes are kept.",
    inputSchema: {
      id: reminderId,
      title: z.string().optional().describe("New title"),
      list: z.string().optional().describe("Move it to this list, by name or id"),
      ...reminderFields,
      completed: z.boolean().optional().describe("Mark completed or not"),
      completion_date: dateTime("Completion").optional(),
      clear_alarms: z.boolean().optional().describe("Remove all alarms"),
      clear_recurrence: z.boolean().optional().describe("Remove the recurrence rules"),
      clear_location_trigger: z.boolean().optional().describe("Remove the location trigger"),
      tags: z.array(z.string()).optional().describe("Replace the tags with these"),
      add_tags: z.array(z.string()).optional().describe("Tags to add"),
      remove_tags: z.array(z.string()).optional().describe("Tags to remove"),
    },
  },
  async (args) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs(camel(args, { list: "targetList" }), UpdateReminderSchema)
      let notes = validated.note
      if (validated.note !== undefined || validated.tags || validated.addTags || validated.removeTags) {
        const current = await reminderRepository.findReminderById(validated.id)
        notes = rebuildNotesForUpdate(
          current.notes,
          validated.note,
          validated.tags,
          validated.addTags,
          validated.removeTags,
        )
      }
      const reminder = await reminderRepository.updateReminder({
        id: validated.id,
        newTitle: validated.title,
        notes,
        url: validated.url,
        location: validated.location,
        isCompleted: validated.completed,
        completionDate: validated.completionDate,
        list: validated.targetList,
        startDate: validated.startDate,
        dueDate: validated.dueDate,
        priority: validated.priority,
        alarms: validated.alarms,
        clearAlarms: validated.clearAlarms,
        recurrenceRules: validated.recurrenceRules,
        clearRecurrence: validated.clearRecurrence,
        locationTrigger: validated.locationTrigger,
        clearLocationTrigger: validated.clearLocationTrigger,
      })
      return formatSuccessMessage("updated", "reminder", reminder.title, reminder.id)
    }, "update reminder"),
)

server.registerTool(
  "delete_reminder",
  { description: "Delete a reminder.", inputSchema: { id: reminderId } },
  async ({ id }) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs({ id }, DeleteReminderSchema)
      await reminderRepository.deleteReminder(validated.id)
      return formatDeleteMessage("reminder", validated.id, { useQuotes: false, useIdPrefix: true, usePeriod: false })
    }, "delete reminder"),
)

// ── Reminder lists ────────────────────────────────────────────────────

const color = z.string().describe("Hex color, e.g. '#FF5733'")

server.registerTool("list_reminder_lists", { description: "List the reminder lists.", inputSchema: {} }, async () =>
  handleAsyncOperation(async () => {
    const lists = await reminderRepository.findAllLists()
    return formatListMarkdown("Reminder Lists", lists, formatReminderList, "No reminder lists found.")
  }, "read reminder lists"),
)

server.registerTool(
  "create_reminder_list",
  {
    description: "Create a reminder list.",
    inputSchema: { name: z.string().min(1).describe("List name"), color: color.optional() },
  },
  async (args) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs(args, CreateReminderListSchema)
      const list = await reminderRepository.createReminderList(validated.name, validated.color)
      return formatSuccessMessage("created", "list", list.title, list.id)
    }, "create reminder list"),
)

server.registerTool(
  "update_reminder_list",
  {
    description: "Rename a reminder list or change its color.",
    inputSchema: { name: listName, new_name: z.string().optional().describe("New name"), color: color.optional() },
  },
  async (args) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs(camel(args), UpdateReminderListSchema)
      const list = await reminderRepository.updateReminderList(validated.name, validated.newName, validated.color)
      return formatSuccessMessage("updated", "list", list.title, list.id)
    }, "update reminder list"),
)

server.registerTool(
  "delete_reminder_list",
  { description: "Delete a reminder list and its reminders.", inputSchema: { name: listName } },
  async (args) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs(args, DeleteReminderListSchema)
      await reminderRepository.deleteReminderList(validated.name)
      return formatDeleteMessage("list", validated.name, { useQuotes: true, useIdPrefix: false, usePeriod: true })
    }, "delete reminder list"),
)

// ── Subtasks ──────────────────────────────────────────────────────────
// Subtasks live in the reminder's notes, so each change rewrites them through updateReminder.

const saveSubtasks = (reminder_id: string, notes: string) =>
  reminderRepository.updateReminder({ id: reminder_id, notes })

server.registerTool(
  "list_subtasks",
  { description: "List a reminder's subtasks with their progress.", inputSchema: { reminder_id: reminderId } },
  async (args) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs(camel(args), ReadSubtasksSchema)
      const reminder = await reminderRepository.findReminderById(validated.reminderId)
      return formatSubtasksListMarkdown(reminder.title, parseSubtasks(reminder.notes))
    }, "read subtasks"),
)

server.registerTool(
  "add_subtask",
  {
    description: "Add a subtask to a reminder.",
    inputSchema: { reminder_id: reminderId, title: z.string().describe("Subtask title") },
  },
  async (args) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs(camel(args), CreateSubtaskSchema)
      const reminder = await reminderRepository.findReminderById(validated.reminderId)
      const { notes, subtask } = addSubtask(validated.title, reminder.notes)
      await saveSubtasks(validated.reminderId, notes)
      return formatSuccessMessage("created", "subtask", subtask.title, subtask.id)
    }, "create subtask"),
)

server.registerTool(
  "update_subtask",
  {
    description: "Rename a subtask or set whether it is completed.",
    inputSchema: {
      reminder_id: reminderId,
      subtask_id: subtaskId,
      title: z.string().optional().describe("New title"),
      completed: z.boolean().optional().describe("Completed or not"),
    },
  },
  async (args) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs(camel(args), UpdateSubtaskSchema)
      const reminder = await reminderRepository.findReminderById(validated.reminderId)
      const notes = updateSubtask(
        validated.subtaskId,
        { title: validated.title, isCompleted: validated.completed },
        reminder.notes,
      )
      await saveSubtasks(validated.reminderId, notes)
      return formatSuccessMessage("updated", "subtask", validated.title ?? "subtask", validated.subtaskId)
    }, "update subtask"),
)

server.registerTool(
  "toggle_subtask",
  {
    description: "Flip a subtask between completed and not completed.",
    inputSchema: { reminder_id: reminderId, subtask_id: subtaskId },
  },
  async (args) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs(camel(args), ToggleSubtaskSchema)
      const reminder = await reminderRepository.findReminderById(validated.reminderId)
      const { notes, subtask } = toggleSubtask(validated.subtaskId, reminder.notes)
      await saveSubtasks(validated.reminderId, notes)
      const status = subtask.isCompleted ? "completed" : "uncompleted"
      return `Successfully marked subtask "${subtask.title}" as ${status}.\n- ID: ${validated.subtaskId}`
    }, "toggle subtask"),
)

server.registerTool(
  "delete_subtask",
  { description: "Delete a subtask.", inputSchema: { reminder_id: reminderId, subtask_id: subtaskId } },
  async (args) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs(camel(args), DeleteSubtaskSchema)
      const reminder = await reminderRepository.findReminderById(validated.reminderId)
      await saveSubtasks(validated.reminderId, removeSubtask(validated.subtaskId, reminder.notes))
      return formatDeleteMessage("subtask", validated.subtaskId)
    }, "delete subtask"),
)

server.registerTool(
  "reorder_subtasks",
  {
    description: "Reorder a reminder's subtasks.",
    inputSchema: {
      reminder_id: reminderId,
      order: z.array(z.string()).describe("Every subtask id, in the new order"),
    },
  },
  async (args) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs(camel(args), ReorderSubtasksSchema)
      const reminder = await reminderRepository.findReminderById(validated.reminderId)
      await saveSubtasks(validated.reminderId, reorderSubtasks(validated.order, reminder.notes))
      return `Successfully reordered ${validated.order.length} subtasks.\n- Reminder ID: ${validated.reminderId}`
    }, "reorder subtasks"),
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
