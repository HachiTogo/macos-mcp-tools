import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { CREATE, DESTRUCTIVE, READ, SET } from "../lib/annotations"
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
  getSubtaskProgress,
  handleAsyncOperation,
  parseSubtasks,
  ReadRemindersSchema,
  ReadSubtasksSchema,
  type Reminder,
  ReorderSubtasksSchema,
  reminderRepository,
  removeSubtask,
  reorderSubtasks,
  snakeKeys,
  stripSubtasks,
  stripTags,
  ToggleSubtaskSchema,
  toggleSubtask,
  UpdateReminderListSchema,
  UpdateReminderSchema,
  UpdateSubtaskSchema,
  updateSubtask,
  validateToolArgs,
} from "../lib/eventkit/index.js"
import { offsetArg, paginate } from "../lib/paging"
import { serve } from "../lib/serve"
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

// Field descriptions are kept for what a name and type cannot say. The date format is stated once,
// in each tool's description.
const DATES = "Dates are local 'YYYY-MM-DD HH:mm:ss' or ISO 8601."
const date = z.string()

const locationTrigger = z.object({
  title: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  radius: z.number().optional().describe("Meters; default 100"),
  proximity: z.enum(["enter", "leave"]),
})

const alarms = z.array(
  z.object({
    relative_offset: z.number().optional().describe("Seconds from the due or start date; negative is before"),
    absolute_date: date.optional(),
    location_trigger: locationTrigger.optional(),
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

const reminderId = z.string().min(1).describe("From list_reminders")
const subtaskId = z.string().min(1).describe("From list_subtasks")
const listName = z.string().min(1).describe("Name or id from list_reminder_lists")
const priority = z.number().int().describe("0 none, 1 high, 5 medium, 9 low")

const reminderFields = {
  start_date: date.optional(),
  due_date: date.optional(),
  note: z.string().optional(),
  location: z.string().optional().describe("Text only; location_trigger sets a geofence"),
  url: z.string().optional(),
  priority: priority.optional(),
  alarms: alarms.optional(),
  recurrence_rules: recurrenceRules.optional(),
  location_trigger: locationTrigger.optional(),
}

// The structuredContent each read tool declares. Objects are loose, so a field present only
// sometimes never fails a call that worked; only ids are pinned.
const withId = z.looseObject({ id: z.string() })
export const remindersOutput = z.looseObject({ reminders: z.array(withId), total: z.number(), offset: z.number() })
export const reminderOutput = z.looseObject({ reminder: withId })
export const reminderListsOutput = z.looseObject({
  lists: z.array(z.looseObject({ id: z.string(), title: z.string() })),
})
export const subtasksOutput = z.looseObject({ reminder_id: z.string(), subtasks: z.array(withId) })

/**
 * A reminder as structuredContent, in the arguments' casing. Its notes hold encoded tags and
 * subtasks, which come back as `tags` and `subtasks`; `note` is the rest, the part update_reminder's
 * `note` replaces.
 */
export const structuredReminder = ({ notes, ...reminder }: Reminder) =>
  snakeKeys({ ...reminder, note: stripSubtasks(stripTags(notes)) || undefined }) as Record<string, unknown>

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
    description: "List reminders, incomplete ones unless show_completed. Every filter given must match.",
    inputSchema: {
      list: z.string().optional().describe("Name or id from list_reminder_lists"),
      show_completed: z.boolean().optional(),
      search: z.string().optional().describe("Matches title or notes"),
      due_within: z.enum(["today", "tomorrow", "this-week", "overdue", "no-date"]).optional(),
      priority: z.enum(["high", "medium", "low", "none"]).optional(),
      recurring: z.boolean().optional(),
      location_based: z.boolean().optional(),
      tags: z.array(z.string()).optional().describe("All must match"),
      limit: z.number().int().min(1).optional().describe("Default: all"),
      offset: offsetArg,
    },
    outputSchema: remindersOutput,
    annotations: READ,
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
      const page = paginate(reminders, offset, limit)
      return {
        text: formatListMarkdown(
          "Reminders",
          page,
          formatReminderMarkdown,
          "No reminders found matching the criteria.",
          {
            offset,
            total: reminders.length,
          },
        ),
        structured: { reminders: page.map(structuredReminder), total: reminders.length, offset },
      }
    }, "read reminders"),
)

server.registerTool(
  "get_reminder",
  {
    description: "Get one reminder by id.",
    inputSchema: { id: reminderId },
    outputSchema: reminderOutput,
    annotations: READ,
  },
  async ({ id }) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs({ id }, ReadRemindersSchema)
      const reminder = await reminderRepository.findReminderById(validated.id as string)
      return {
        text: ["### Reminder", "", ...formatReminderMarkdown(reminder)].join("\n"),
        structured: { reminder: structuredReminder(reminder) },
      }
    }, "read reminders"),
)

server.registerTool(
  "create_reminder",
  {
    description: `Create a reminder, optionally with tags and subtasks. ${DATES}`,
    inputSchema: {
      title: z.string(),
      list: z.string().optional().describe("Name or id; default list if omitted"),
      ...reminderFields,
      completed: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      subtasks: z.array(z.string()).optional().describe("Subtask titles"),
    },
    annotations: CREATE,
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
    description: `Update a reminder; only the fields given change, and tags and subtasks in its notes are kept. ${DATES}`,
    inputSchema: {
      id: reminderId,
      title: z.string().optional(),
      list: z.string().optional().describe("Move to this list (name or id)"),
      ...reminderFields,
      completed: z.boolean().optional(),
      completion_date: date.optional(),
      clear_alarms: z.boolean().optional(),
      clear_recurrence: z.boolean().optional(),
      clear_location_trigger: z.boolean().optional(),
      tags: z.array(z.string()).optional().describe("Replaces all tags"),
      add_tags: z.array(z.string()).optional(),
      remove_tags: z.array(z.string()).optional(),
    },
    annotations: DESTRUCTIVE,
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
  { description: "Delete a reminder.", inputSchema: { id: reminderId }, annotations: DESTRUCTIVE },
  async ({ id }) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs({ id }, DeleteReminderSchema)
      await reminderRepository.deleteReminder(validated.id)
      return formatDeleteMessage("reminder", validated.id, { useQuotes: false, useIdPrefix: true, usePeriod: false })
    }, "delete reminder"),
)

// ── Reminder lists ────────────────────────────────────────────────────

const color = z.string().describe("Hex, e.g. '#FF5733'")

server.registerTool(
  "list_reminder_lists",
  { description: "List the reminder lists.", inputSchema: {}, outputSchema: reminderListsOutput, annotations: READ },
  async () =>
    handleAsyncOperation(async () => {
      const lists = await reminderRepository.findAllLists()
      return {
        text: formatListMarkdown("Reminder Lists", lists, formatReminderList, "No reminder lists found."),
        structured: { lists: snakeKeys(lists) },
      }
    }, "read reminder lists"),
)

server.registerTool(
  "create_reminder_list",
  {
    description: "Create a reminder list.",
    inputSchema: { name: z.string().min(1), color: color.optional() },
    annotations: CREATE,
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
    inputSchema: { name: listName, new_name: z.string().optional(), color: color.optional() },
    annotations: DESTRUCTIVE,
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
  {
    description: "Delete a reminder list and its reminders.",
    inputSchema: { name: listName },
    annotations: DESTRUCTIVE,
  },
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
  {
    description: "List a reminder's subtasks with their progress.",
    inputSchema: { reminder_id: reminderId },
    outputSchema: subtasksOutput,
    annotations: READ,
  },
  async (args) =>
    handleAsyncOperation(async () => {
      const validated = validateToolArgs(camel(args), ReadSubtasksSchema)
      const reminder = await reminderRepository.findReminderById(validated.reminderId)
      const subtasks = parseSubtasks(reminder.notes)
      return {
        text: formatSubtasksListMarkdown(reminder.title, subtasks),
        structured: snakeKeys({ reminderId: reminder.id, subtasks, progress: getSubtaskProgress(subtasks) }) as Record<
          string,
          unknown
        >,
      }
    }, "read subtasks"),
)

server.registerTool(
  "add_subtask",
  {
    description: "Add a subtask to a reminder.",
    inputSchema: { reminder_id: reminderId, title: z.string() },
    annotations: CREATE,
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
      title: z.string().optional(),
      completed: z.boolean().optional(),
    },
    annotations: DESTRUCTIVE,
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
    annotations: { ...SET, idempotentHint: false },
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
  {
    description: "Delete a subtask.",
    inputSchema: { reminder_id: reminderId, subtask_id: subtaskId },
    annotations: DESTRUCTIVE,
  },
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
    annotations: SET,
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

export const main = () => serve(server)

// Boot only when executed directly; cli.ts and tests import this module without starting a server.
if (import.meta.main) {
  await main()
}
