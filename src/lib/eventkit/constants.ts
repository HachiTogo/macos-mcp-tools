export const FILE_SYSTEM = {
  MAX_DIRECTORY_SEARCH_DEPTH: 10,
  PACKAGE_JSON_FILENAME: 'package.json',
  SWIFT_BINARY_NAME: 'EventKitCLI',
} as const;

export const VALIDATION = {
  MAX_TITLE_LENGTH: 200,
  MAX_NOTE_LENGTH: 20000,
  MAX_LIST_NAME_LENGTH: 100,
  MAX_SEARCH_LENGTH: 100,
  MAX_URL_LENGTH: 500,
  MAX_LOCATION_LENGTH: 200,
} as const;

export const TOOLS = {
  REMINDERS_TASKS: 'reminders_tasks',
  REMINDERS_LISTS: 'reminders_lists',
  REMINDERS_SUBTASKS: 'reminders_subtasks',
  CALENDAR_EVENTS: 'calendar_events',
  CALENDAR_CALENDARS: 'calendar_calendars',
} as const;

export const TIME = {
  WORKING_HOURS_START: 9,
  WORKING_HOURS_END: 18,
  MORNING_START: 5,
  NOON: 12,
  AFTERNOON_END: 17,
  EVENING_START: 17,
  NIGHT_START: 21,
  LATER_TODAY_HOURS: 4,
  END_OF_WEEK_HOUR: 17,
  DEFAULT_MORNING_HOUR: 9,
  SUNDAY: 0,
  FRIDAY: 5,
  SATURDAY: 6,
} as const;

export const MESSAGES = {
  ERROR: {
    INPUT_VALIDATION_FAILED: (details: string) =>
      `Input validation failed: ${details}`,
    UNKNOWN_TOOL: (name: string) => `Unknown tool: ${name}`,
    UNKNOWN_ACTION: (tool: string, action: string) =>
      `Unknown ${tool} action: ${action}`,
    SYSTEM_ERROR: (operation: string) =>
      `Failed to ${operation}: System error occurred`,
  },
} as const;
