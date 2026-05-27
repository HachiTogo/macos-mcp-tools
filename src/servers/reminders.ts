import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  reminderRepository,
  extractAndValidateArgs,
  formatDeleteMessage,
  formatListMarkdown,
  formatMultilineNotes,
  formatSuccessMessage,
  handleAsyncOperation,
  PRIORITY_LABELS,
  CreateReminderSchema,
  DeleteReminderSchema,
  ReadRemindersSchema,
  UpdateReminderSchema,
  CreateReminderListSchema,
  UpdateReminderListSchema,
  DeleteReminderListSchema,
  ReadSubtasksSchema,
  CreateSubtaskSchema,
  UpdateSubtaskSchema,
  DeleteSubtaskSchema,
  ToggleSubtaskSchema,
  ReorderSubtasksSchema,
  combineTagsAndNotes,
  combineSubtasksAndNotes,
  createSubtasksFromTitles,
  parseSubtasks,
  stripSubtasks,
  stripTags,
  extractTags,
  addTagsToNotes,
  removeTagsFromNotes,
  addSubtask,
  updateSubtask,
  removeSubtask,
  toggleSubtask,
  reorderSubtasks,
  getSubtaskProgress,
} from "../lib/eventkit/index.js";
import type {
  Alarm,
  LocationTrigger,
  RecurrenceRule,
  RemindersToolArgs,
  ListsToolArgs,
  SubtasksToolArgs,
  Subtask,
} from "../lib/eventkit/index.js";

// ── Helpers ───────────────────────────────────────────────────────────

function rebuildNotesForUpdate(
  currentNotes: string | undefined,
  newNote: string | undefined,
  tags: string[] | undefined,
  addTags: string[] | undefined,
  removeTags: string[] | undefined,
): string {
  const existingNotes = currentNotes ?? "";
  const existingSubtasks = parseSubtasks(existingNotes);
  const notesWithoutSubtasks = stripSubtasks(existingNotes);

  let notesWithTags = notesWithoutSubtasks;

  if (addTags && addTags.length > 0) {
    notesWithTags = addTagsToNotes(addTags, notesWithTags);
  }

  if (removeTags && removeTags.length > 0) {
    notesWithTags = removeTagsFromNotes(removeTags, notesWithTags);
  }

  if (tags) {
    const baseNote =
      newNote !== undefined
        ? stripSubtasks(stripTags(newNote))
        : stripTags(notesWithoutSubtasks);
    notesWithTags = combineTagsAndNotes(tags, baseNote);
  } else if (newNote !== undefined) {
    const cleanNewNote = stripSubtasks(stripTags(newNote));
    const tagsFromExisting = extractTags(notesWithTags);
    notesWithTags = combineTagsAndNotes(tagsFromExisting, cleanNewNote);
  }

  return combineSubtasksAndNotes(existingSubtasks, notesWithTags);
}

// ── Reminder formatters ───────────────────────────────────────────────

const formatRecurrence = (recurrence: RecurrenceRule): string => {
  const parts: string[] = [];
  const interval =
    recurrence.interval > 1 ? `every ${recurrence.interval} ` : "";

  switch (recurrence.frequency) {
    case "minutely":
      parts.push(`${interval}minute${recurrence.interval > 1 ? "s" : ""}`);
      break;
    case "hourly":
      parts.push(`${interval}hour${recurrence.interval > 1 ? "s" : ""}`);
      break;
    case "daily":
      parts.push(`${interval}day${recurrence.interval > 1 ? "s" : ""}`);
      break;
    case "weekly":
      parts.push(`${interval}week${recurrence.interval > 1 ? "s" : ""}`);
      if (recurrence.daysOfWeek?.length) {
        const dayNames = ["", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const days = recurrence.daysOfWeek.map((d) => dayNames[d]).join(", ");
        parts.push(`on ${days}`);
      }
      break;
    case "monthly":
      parts.push(`${interval}month${recurrence.interval > 1 ? "s" : ""}`);
      if (recurrence.daysOfMonth?.length) {
        parts.push(
          `on day${recurrence.daysOfMonth.length > 1 ? "s" : ""} ${recurrence.daysOfMonth.join(", ")}`,
        );
      }
      break;
    case "yearly":
      parts.push(`${interval}year${recurrence.interval > 1 ? "s" : ""}`);
      if (recurrence.monthsOfYear?.length) {
        const monthNames = [
          "",
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ];
        const months = recurrence.monthsOfYear
          .map((m) => monthNames[m])
          .join(", ");
        parts.push(`in ${months}`);
      }
      break;
    default: {
      const exhaustiveCheck: never = recurrence.frequency;
      throw new Error(`Unknown recurrence frequency: ${exhaustiveCheck}`);
    }
  }

  if (recurrence.endDate) {
    parts.push(`until ${recurrence.endDate}`);
  } else if (recurrence.occurrenceCount) {
    parts.push(`(${recurrence.occurrenceCount} times)`);
  }

  return parts.join(" ");
};

const formatRecurrenceRules = (rules: RecurrenceRule[]): string => {
  if (rules.length === 1) return formatRecurrence(rules[0]);
  return rules.map((rule) => formatRecurrence(rule)).join("; ");
};

const formatAlarm = (alarm: Alarm): string => {
  let typeStr = "";
  if (alarm.alarmType) {
    typeStr = ` (${alarm.alarmType})`;
  }
  if (alarm.absoluteDate) return `at ${alarm.absoluteDate}${typeStr}`;
  if (alarm.relativeOffset !== undefined)
    return `${alarm.relativeOffset}s from due/start${typeStr}`;
  if (alarm.locationTrigger)
    return `on ${formatLocationTrigger(alarm.locationTrigger)}${typeStr}`;
  return "unknown";
};

const formatLocationTrigger = (location: LocationTrigger): string => {
  const proximityText =
    location.proximity === "enter" ? "Arriving at" : "Leaving";
  const radiusText = location.radius ? ` (${location.radius}m radius)` : "";
  return `${proximityText} "${location.title}"${radiusText}`;
};

const buildReminderIcons = (reminder: {
  recurrence?: RecurrenceRule;
  recurrenceRules?: RecurrenceRule[];
  locationTrigger?: LocationTrigger;
  tags?: string[];
  subtasks?: Subtask[];
}): string => {
  const icons: string[] = [];
  if (reminder.recurrenceRules && reminder.recurrenceRules.length > 0)
    icons.push("\u{1F504}");
  if (reminder.locationTrigger) icons.push("\u{1F4CD}");
  if (reminder.tags && reminder.tags.length > 0) icons.push("\u{1F3F7}️");
  if (reminder.subtasks && reminder.subtasks.length > 0) icons.push("\u{1F4CB}");
  return icons.length > 0 ? ` ${icons.join("")}` : "";
};

const formatReminderMarkdown = (reminder: {
  title: string;
  isCompleted: boolean;
  list?: string;
  id?: string;
  notes?: string;
  dueDate?: string;
  url?: string;
  location?: string;
  priority?: number;
  recurrence?: RecurrenceRule;
  recurrenceRules?: RecurrenceRule[];
  locationTrigger?: LocationTrigger;
  alarms?: Alarm[];
  completionDate?: string;
  startDate?: string;
  creationDate?: string;
  lastModifiedDate?: string;
  externalId?: string;
  tags?: string[];
  subtasks?: Subtask[];
  subtaskProgress?: { completed: number; total: number; percentage: number };
}): string[] => {
  const lines: string[] = [];
  const checkbox = reminder.isCompleted ? "[x]" : "[ ]";
  const icons = buildReminderIcons(reminder);
  lines.push(`- ${checkbox} ${reminder.title}${icons}`);
  if (reminder.list) lines.push(`  - List: ${reminder.list}`);
  if (reminder.id) lines.push(`  - ID: ${reminder.id}`);
  if (reminder.priority !== undefined) {
    const priorityLabel = PRIORITY_LABELS[reminder.priority] ?? "unknown";
    lines.push(`  - Priority: ${priorityLabel} (${reminder.priority})`);
  }
  if (reminder.startDate) lines.push(`  - Start: ${reminder.startDate}`);
  if (reminder.tags && reminder.tags.length > 0) {
    lines.push(`  - Tags: ${reminder.tags.map((t) => `#${t}`).join(" ")}`);
  }
  const recurrenceRules =
    reminder.recurrenceRules ??
    (reminder.recurrence ? [reminder.recurrence] : undefined);
  if (recurrenceRules && recurrenceRules.length > 0) {
    lines.push(`  - Repeats: ${formatRecurrenceRules(recurrenceRules)}`);
  }
  if (reminder.locationTrigger) {
    lines.push(
      `  - Location: ${formatLocationTrigger(reminder.locationTrigger)}`,
    );
  }
  if (reminder.location) lines.push(`  - Location Text: ${reminder.location}`);
  if (reminder.alarms && reminder.alarms.length > 0) {
    lines.push(`  - Alarms: ${reminder.alarms.map(formatAlarm).join("; ")}`);
  }
  if (reminder.subtasks && reminder.subtasks.length > 0) {
    const progress = reminder.subtaskProgress;
    const progressText = progress
      ? ` (${progress.completed}/${progress.total})`
      : "";
    lines.push(`  - Subtasks${progressText}:`);
    for (const subtask of reminder.subtasks) {
      const subtaskCheckbox = subtask.isCompleted ? "[x]" : "[ ]";
      lines.push(`    - ${subtaskCheckbox} ${subtask.title}`);
    }
  }
  const cleanNotes = stripSubtasks(stripTags(reminder.notes));
  if (cleanNotes) {
    lines.push(`  - Notes: ${formatMultilineNotes(cleanNotes)}`);
  }
  if (reminder.dueDate) lines.push(`  - Due: ${reminder.dueDate}`);
  if (reminder.completionDate)
    lines.push(`  - Completed: ${reminder.completionDate}`);
  if (reminder.url) lines.push(`  - URL: ${reminder.url}`);
  if (reminder.externalId)
    lines.push(`  - External ID: ${reminder.externalId}`);
  if (reminder.creationDate)
    lines.push(`  - Created: ${reminder.creationDate}`);
  if (reminder.lastModifiedDate)
    lines.push(`  - Modified: ${reminder.lastModifiedDate}`);
  return lines;
};

// ── List formatter ────────────────────────────────────────────────────

const formatReminderList = (list: {
  title: string;
  id: string;
  color?: string;
}): string[] => {
  let display = list.title;
  if (list.color) {
    display = `${display} (Color: ${list.color})`;
  }
  return [`- ${display} (ID: ${list.id})`];
};

// ── Subtask formatters ────────────────────────────────────────────────

const formatSubtaskMarkdown = (subtask: Subtask, index: number): string => {
  const checkbox = subtask.isCompleted ? "[x]" : "[ ]";
  return `${index + 1}. ${checkbox} ${subtask.title} (ID: ${subtask.id})`;
};

const formatSubtasksListMarkdown = (
  reminderTitle: string,
  subtasks: Subtask[],
): string => {
  const lines: string[] = [];
  const progress = getSubtaskProgress(subtasks);

  lines.push(`### Subtasks for "${reminderTitle}"`);
  lines.push("");
  lines.push(
    `**Progress:** ${progress.completed}/${progress.total} (${progress.percentage}%)`,
  );
  lines.push("");

  if (subtasks.length === 0) {
    lines.push("No subtasks found.");
  } else {
    subtasks.forEach((subtask, index) => {
      lines.push(formatSubtaskMarkdown(subtask, index));
    });
  }

  return lines.join("\n");
};

// ── MCP Server ────────────────────────────────────────────────────────

const server = new McpServer({
  name: "apple-reminders",
  version: "0.0.1",
});

// ── reminders_tasks ───────────────────────────────────────────────────

server.registerTool(
  "reminders_tasks",
  {
    description:
      "Manages reminder tasks. Supports reading, creating, updating, and deleting reminders.",
    inputSchema: {
      action: z.enum(["read", "create", "update", "delete"]).describe("The operation to perform"),
      id: z.string().optional().describe("The unique identifier of the reminder (REQUIRED for update, delete; optional for read to get single reminder)"),
      title: z.string().optional().describe("The title of the reminder (REQUIRED for create, optional for update)"),
      startDate: z.string().optional().describe("Start date. RECOMMENDED format: 'YYYY-MM-DD HH:mm:ss' (local time). Also supports ISO 8601"),
      dueDate: z.string().optional().describe("Due date. RECOMMENDED format: 'YYYY-MM-DD HH:mm:ss' (local time). Also supports ISO 8601"),
      completionDate: z.string().optional().describe("Completion date/time (for update)"),
      note: z.string().optional().describe("Additional notes for the reminder"),
      location: z.string().optional().describe("Location text for the reminder (not the same as a location-based trigger)"),
      url: z.string().optional().describe("A URL to associate with the reminder"),
      completed: z.boolean().optional().describe("The completion status of the reminder (for update)"),
      priority: z
        .number()
        .int()
        .optional()
        .describe("Priority level: 0=none, 1=high, 5=medium, 9=low"),
      alarms: z
        .array(
          z.object({
            relativeOffset: z.number().optional().describe("Seconds offset (negative = before due/start)"),
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
        .describe("Alarms for the reminder"),
      clearAlarms: z.boolean().optional().describe("Set to true to remove all alarms from the reminder"),
      targetList: z.string().optional().describe("The name of the list for create or update operations"),
      filterList: z.string().optional().describe("Filter reminders by a specific list name"),
      showCompleted: z.boolean().optional().describe("Include completed reminders in the results"),
      search: z.string().optional().describe("Search term to filter reminders by title or notes"),
      dueWithin: z
        .enum(["today", "tomorrow", "this-week", "overdue", "no-date"])
        .optional()
        .describe("Filter reminders by a due date range"),
      filterPriority: z
        .enum(["high", "medium", "low", "none"])
        .optional()
        .describe("Filter reminders by priority level"),
      filterRecurring: z.boolean().optional().describe("Filter to only show recurring reminders when true"),
      filterLocationBased: z.boolean().optional().describe("Filter to only show location-based reminders when true"),
      filterTags: z
        .array(z.string())
        .optional()
        .describe("Filter reminders by tags (must have ALL specified tags)"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags to set on the reminder (for create). Replaces any existing tags"),
      addTags: z
        .array(z.string())
        .optional()
        .describe("Tags to add to the reminder (for update). Merges with existing tags"),
      removeTags: z
        .array(z.string())
        .optional()
        .describe("Tags to remove from the reminder (for update)"),
      subtasks: z
        .array(z.string())
        .optional()
        .describe("Initial subtasks to create with the reminder (for create action). Array of subtask titles"),
      recurrence: z
        .object({
          frequency: z.enum(["minutely", "hourly", "daily", "weekly", "monthly", "yearly"]),
          interval: z.number().int().optional().describe("Interval between occurrences (default 1)"),
          endDate: z.string().optional().describe("When the recurrence ends (YYYY-MM-DD)"),
          occurrenceCount: z.number().int().optional().describe("Number of times to repeat"),
          daysOfWeek: z.array(z.number().int()).optional().describe("Days of week (1=Sunday, 7=Saturday)"),
          daysOfMonth: z.array(z.number().int()).optional().describe("Days of month (1-31)"),
          monthsOfYear: z.array(z.number().int()).optional().describe("Months for yearly recurrence (1-12)"),
        })
        .optional()
        .describe("Single recurrence rule for repeating reminders"),
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
        .describe("Recurrence rules for repeating reminders"),
      clearRecurrence: z.boolean().optional().describe("Set to true to remove recurrence from an existing reminder (for update)"),
      locationTrigger: z
        .object({
          title: z.string().describe("Location name/title"),
          latitude: z.number().describe("Latitude coordinate"),
          longitude: z.number().describe("Longitude coordinate"),
          radius: z.number().optional().describe("Geofence radius in meters (default 100)"),
          proximity: z.enum(["enter", "leave"]).describe("When to trigger: enter or leave"),
        })
        .optional()
        .describe("Location trigger for geofence-based reminders"),
      clearLocationTrigger: z.boolean().optional().describe("Set to true to remove location trigger from an existing reminder (for update)"),
    },
  },
  async (args) => {
    switch (args.action) {
      case "read":
        return handleAsyncOperation(async () => {
          const validatedArgs = extractAndValidateArgs(args as RemindersToolArgs, ReadRemindersSchema);

          if (validatedArgs.id) {
            const reminder = await reminderRepository.findReminderById(validatedArgs.id);
            const markdownLines: string[] = [
              "### Reminder",
              "",
              ...formatReminderMarkdown(reminder),
            ];
            return markdownLines.join("\n");
          }

          const reminders = await reminderRepository.findReminders({
            list: validatedArgs.filterList,
            showCompleted: validatedArgs.showCompleted,
            search: validatedArgs.search,
            dueWithin: validatedArgs.dueWithin,
            priority: validatedArgs.filterPriority,
            recurring: validatedArgs.filterRecurring,
            locationBased: validatedArgs.filterLocationBased,
            tags: validatedArgs.filterTags,
          });

          return formatListMarkdown(
            "Reminders",
            reminders,
            formatReminderMarkdown,
            "No reminders found matching the criteria.",
          );
        }, "read reminders");

      case "create":
        return handleAsyncOperation(async () => {
          const validatedArgs = extractAndValidateArgs(args as RemindersToolArgs, CreateReminderSchema);

          let notesWithMetadata = validatedArgs.tags
            ? combineTagsAndNotes(validatedArgs.tags, validatedArgs.note)
            : validatedArgs.note;

          if (validatedArgs.subtasks && validatedArgs.subtasks.length > 0) {
            const subtasks = createSubtasksFromTitles(validatedArgs.subtasks);
            notesWithMetadata = combineSubtasksAndNotes(subtasks, notesWithMetadata);
          }

          const reminder = await reminderRepository.createReminder({
            title: validatedArgs.title,
            notes: notesWithMetadata,
            url: validatedArgs.url,
            location: validatedArgs.location,
            list: validatedArgs.targetList,
            startDate: validatedArgs.startDate,
            dueDate: validatedArgs.dueDate,
            priority: validatedArgs.priority,
            isCompleted: validatedArgs.completed,
            alarms: validatedArgs.alarms,
            recurrenceRules:
              validatedArgs.recurrenceRules ??
              (validatedArgs.recurrence ? [validatedArgs.recurrence] : undefined),
            locationTrigger: validatedArgs.locationTrigger,
          });
          return formatSuccessMessage(
            "created",
            "reminder",
            reminder.title,
            reminder.id,
          );
        }, "create reminder");

      case "update":
        return handleAsyncOperation(async () => {
          const validatedArgs = extractAndValidateArgs(args as RemindersToolArgs, UpdateReminderSchema);

          let notesToSend = validatedArgs.note;
          const shouldRebuildNotes =
            validatedArgs.note !== undefined ||
            Boolean(validatedArgs.tags) ||
            Boolean(validatedArgs.addTags) ||
            Boolean(validatedArgs.removeTags);

          if (shouldRebuildNotes) {
            const currentReminder = await reminderRepository.findReminderById(
              validatedArgs.id,
            );
            notesToSend = rebuildNotesForUpdate(
              currentReminder.notes,
              validatedArgs.note,
              validatedArgs.tags,
              validatedArgs.addTags,
              validatedArgs.removeTags,
            );
          }

          const reminder = await reminderRepository.updateReminder({
            id: validatedArgs.id,
            newTitle: validatedArgs.title,
            notes: notesToSend,
            url: validatedArgs.url,
            location: validatedArgs.location,
            isCompleted: validatedArgs.completed,
            completionDate: validatedArgs.completionDate,
            list: validatedArgs.targetList,
            startDate: validatedArgs.startDate,
            dueDate: validatedArgs.dueDate,
            priority: validatedArgs.priority,
            alarms: validatedArgs.alarms,
            clearAlarms: validatedArgs.clearAlarms,
            recurrenceRules:
              validatedArgs.recurrenceRules ??
              (validatedArgs.recurrence ? [validatedArgs.recurrence] : undefined),
            clearRecurrence: validatedArgs.clearRecurrence,
            locationTrigger: validatedArgs.locationTrigger,
            clearLocationTrigger: validatedArgs.clearLocationTrigger,
          });
          return formatSuccessMessage(
            "updated",
            "reminder",
            reminder.title,
            reminder.id,
          );
        }, "update reminder");

      case "delete":
        return handleAsyncOperation(async () => {
          const validatedArgs = extractAndValidateArgs(args as RemindersToolArgs, DeleteReminderSchema);
          await reminderRepository.deleteReminder(validatedArgs.id);
          return formatDeleteMessage("reminder", validatedArgs.id, {
            useQuotes: false,
            useIdPrefix: true,
            usePeriod: false,
          });
        }, "delete reminder");

      default:
        return { content: [{ type: "text" as const, text: "Unknown action" }], isError: true };
    }
  },
);

// ── reminders_lists ───────────────────────────────────────────────────

server.registerTool(
  "reminders_lists",
  {
    description:
      "Manages reminder lists. Supports reading, creating, updating, and deleting reminder lists.",
    inputSchema: {
      action: z.enum(["read", "create", "update", "delete"]).describe("The operation to perform on a list"),
      name: z.string().optional().describe("The current name of the list (for update, delete) or the name of the new list (for create)"),
      newName: z.string().optional().describe("The new name for the list (for update)"),
      color: z.string().optional().describe("The hex color code for the list (e.g., '#FF5733')"),
    },
  },
  async (args) => {
    switch (args.action) {
      case "read":
        return handleAsyncOperation(async () => {
          const lists = await reminderRepository.findAllLists();
          return formatListMarkdown(
            "Reminder Lists",
            lists,
            formatReminderList,
            "No reminder lists found.",
          );
        }, "read reminder lists");

      case "create":
        return handleAsyncOperation(async () => {
          const validatedArgs = extractAndValidateArgs(args as ListsToolArgs, CreateReminderListSchema);
          const list = await reminderRepository.createReminderList(
            validatedArgs.name,
            validatedArgs.color,
          );
          return formatSuccessMessage("created", "list", list.title, list.id);
        }, "create reminder list");

      case "update":
        return handleAsyncOperation(async () => {
          const validatedArgs = extractAndValidateArgs(args as ListsToolArgs, UpdateReminderListSchema);
          const list = await reminderRepository.updateReminderList(
            validatedArgs.name,
            validatedArgs.newName,
            validatedArgs.color,
          );
          return formatSuccessMessage("updated", "list", list.title, list.id);
        }, "update reminder list");

      case "delete":
        return handleAsyncOperation(async () => {
          const validatedArgs = extractAndValidateArgs(args as ListsToolArgs, DeleteReminderListSchema);
          await reminderRepository.deleteReminderList(validatedArgs.name);
          return formatDeleteMessage("list", validatedArgs.name, {
            useQuotes: true,
            useIdPrefix: false,
            usePeriod: true,
          });
        }, "delete reminder list");

      default:
        return { content: [{ type: "text" as const, text: "Unknown action" }], isError: true };
    }
  },
);

// ── reminders_subtasks ────────────────────────────────────────────────

server.registerTool(
  "reminders_subtasks",
  {
    description: "Manages subtasks/checklists within reminders.",
    inputSchema: {
      action: z
        .enum(["read", "create", "update", "delete", "toggle", "reorder"])
        .describe("The operation to perform: read, create, update, delete, toggle, reorder"),
      reminderId: z.string().describe("The unique identifier of the parent reminder (REQUIRED for all operations)"),
      subtaskId: z.string().optional().describe("The unique identifier of the subtask (REQUIRED for update, delete, toggle)"),
      title: z.string().optional().describe("The title of the subtask (REQUIRED for create, optional for update)"),
      completed: z.boolean().optional().describe("The completion status of the subtask (for update)"),
      order: z
        .array(z.string())
        .optional()
        .describe("Array of subtask IDs in desired order (REQUIRED for reorder). Must include all subtask IDs"),
    },
  },
  async (args) => {
    switch (args.action) {
      case "read":
        return handleAsyncOperation(async () => {
          const validatedArgs = extractAndValidateArgs(args as SubtasksToolArgs, ReadSubtasksSchema);
          const reminder = await reminderRepository.findReminderById(validatedArgs.reminderId);
          const subtasks = parseSubtasks(reminder.notes);
          return formatSubtasksListMarkdown(reminder.title, subtasks);
        }, "read subtasks");

      case "create":
        return handleAsyncOperation(async () => {
          const validatedArgs = extractAndValidateArgs(args as SubtasksToolArgs, CreateSubtaskSchema);
          const reminder = await reminderRepository.findReminderById(validatedArgs.reminderId);
          const { notes: updatedNotes, subtask } = addSubtask(
            validatedArgs.title,
            reminder.notes,
          );
          await reminderRepository.updateReminder({
            id: validatedArgs.reminderId,
            notes: updatedNotes,
          });
          return formatSuccessMessage(
            "created",
            "subtask",
            subtask.title,
            subtask.id,
          );
        }, "create subtask");

      case "update":
        return handleAsyncOperation(async () => {
          const validatedArgs = extractAndValidateArgs(args as SubtasksToolArgs, UpdateSubtaskSchema);
          const reminder = await reminderRepository.findReminderById(validatedArgs.reminderId);
          const updatedNotes = updateSubtask(
            validatedArgs.subtaskId,
            {
              title: validatedArgs.title,
              isCompleted: validatedArgs.completed,
            },
            reminder.notes,
          );
          await reminderRepository.updateReminder({
            id: validatedArgs.reminderId,
            notes: updatedNotes,
          });
          return formatSuccessMessage(
            "updated",
            "subtask",
            validatedArgs.title ?? "subtask",
            validatedArgs.subtaskId,
          );
        }, "update subtask");

      case "delete":
        return handleAsyncOperation(async () => {
          const validatedArgs = extractAndValidateArgs(args as SubtasksToolArgs, DeleteSubtaskSchema);
          const reminder = await reminderRepository.findReminderById(validatedArgs.reminderId);
          const updatedNotes = removeSubtask(validatedArgs.subtaskId, reminder.notes);
          await reminderRepository.updateReminder({
            id: validatedArgs.reminderId,
            notes: updatedNotes,
          });
          return formatDeleteMessage("subtask", validatedArgs.subtaskId);
        }, "delete subtask");

      case "toggle":
        return handleAsyncOperation(async () => {
          const validatedArgs = extractAndValidateArgs(args as SubtasksToolArgs, ToggleSubtaskSchema);
          const reminder = await reminderRepository.findReminderById(validatedArgs.reminderId);
          const { notes: updatedNotes, subtask } = toggleSubtask(
            validatedArgs.subtaskId,
            reminder.notes,
          );
          await reminderRepository.updateReminder({
            id: validatedArgs.reminderId,
            notes: updatedNotes,
          });
          const status = subtask.isCompleted ? "completed" : "uncompleted";
          return `Successfully marked subtask "${subtask.title}" as ${status}.\n- ID: ${validatedArgs.subtaskId}`;
        }, "toggle subtask");

      case "reorder":
        return handleAsyncOperation(async () => {
          const validatedArgs = extractAndValidateArgs(args as SubtasksToolArgs, ReorderSubtasksSchema);
          const reminder = await reminderRepository.findReminderById(validatedArgs.reminderId);
          const updatedNotes = reorderSubtasks(validatedArgs.order, reminder.notes);
          await reminderRepository.updateReminder({
            id: validatedArgs.reminderId,
            notes: updatedNotes,
          });
          return `Successfully reordered ${validatedArgs.order.length} subtasks.\n- Reminder ID: ${validatedArgs.reminderId}`;
        }, "reorder subtasks");

      default:
        return { content: [{ type: "text" as const, text: "Unknown action" }], isError: true };
    }
  },
);

// ── Entry point ───────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
