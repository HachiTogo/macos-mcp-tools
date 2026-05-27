import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ValidationError, validateInput } from './schemas.js';
import type {
  CalendarsToolArgs,
  CalendarToolArgs,
  ListsToolArgs,
  RemindersToolArgs,
  SubtasksToolArgs,
} from './types.js';

// CLI argument helpers

export function addOptionalArg(
  args: string[],
  flag: string,
  value: string | undefined,
): void {
  if (value !== undefined) {
    args.push(flag, value);
  }
}

export function addOptionalBooleanArg(
  args: string[],
  flag: string,
  value: boolean | undefined,
): void {
  if (value !== undefined) {
    args.push(flag, String(value));
  }
}

export function addOptionalNumberArg(
  args: string[],
  flag: string,
  value: number | undefined,
): void {
  if (value !== undefined) {
    args.push(flag, String(value));
  }
}

export function addOptionalJsonArg(
  args: string[],
  flag: string,
  value: object | undefined,
): void {
  if (value) {
    args.push(flag, JSON.stringify(value));
  }
}

// Null-to-undefined converters

export function nullToUndefined<T>(obj: T, fields: (keyof T)[]): T {
  const result = { ...obj } as Record<string, unknown>;
  for (const field of fields) {
    const fieldKey = String(field);
    if (result[fieldKey] === null) {
      result[fieldKey] = undefined;
    }
  }
  return result as T;
}

export function nullsToUndefined<T extends object>(
  obj: T,
): {
  [K in keyof T]: T[K] extends null ? undefined : T[K];
} {
  const result = { ...obj } as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (result[key] === null) {
      result[key] = undefined;
    }
  }
  return result as { [K in keyof T]: T[K] extends null ? undefined : T[K] };
}

// String utilities

export function bufferToString(data?: string | Buffer | null): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return data ?? null;
}

export function formatMultilineNotes(notes: string): string {
  return notes.replace(/\n/g, '\n    ');
}

// Error handling

const USER_ACTIONABLE_PERMISSION_PATTERNS = [
  /permission denied/i,
  /permission is write-only/i,
  /access denied/i,
  /not authorized.*(calendar|reminders)/i,
  /System Settings > Privacy & Security/i,
  /full calendar access/i,
  /full reminder access/i,
] as const;

function isUserActionablePermissionError(message: string): boolean {
  return USER_ACTIONABLE_PERMISSION_PATTERNS.some((pattern) =>
    pattern.test(message),
  );
}

export class CliUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUserError';
  }
}

export function isDevelopmentMode(): boolean {
  return (
    process.env.NODE_ENV === 'development' ||
    (!!process.env.DEBUG && process.env.DEBUG !== '')
  );
}

function createErrorMessage(operation: string, error: unknown): string {
  const message =
    error instanceof Error ? error.message : 'System error occurred';
  const isDev = isDevelopmentMode();

  if (error instanceof ValidationError || error instanceof CliUserError) {
    return message;
  }

  if (isUserActionablePermissionError(message)) {
    return `Failed to ${operation}: ${message}`;
  }

  return isDev
    ? `Failed to ${operation}: ${message}`
    : `Failed to ${operation}: System error occurred`;
}

export async function handleAsyncOperation(
  operation: () => Promise<string>,
  operationName: string,
): Promise<CallToolResult> {
  try {
    const result = await operation();
    return {
      content: [{ type: 'text', text: result }],
      isError: false,
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: createErrorMessage(operationName, error),
        },
      ],
      isError: true,
    };
  }
}

// Shared handler helpers

export const extractAndValidateArgs = <T>(
  args:
    | RemindersToolArgs
    | ListsToolArgs
    | SubtasksToolArgs
    | CalendarToolArgs
    | CalendarsToolArgs
    | undefined,
  schema: z.ZodType<T>,
): T => {
  const { action: _, ...rest } = args ?? {};
  return validateInput(schema, rest);
};

export const formatListMarkdown = <T>(
  title: string,
  items: T[],
  formatItem: (item: T) => string[],
  emptyMessage: string,
): string => {
  const lines: string[] = [`### ${title} (Total: ${items.length})`, ''];

  if (items.length === 0) {
    lines.push(emptyMessage);
  } else {
    items.forEach((item) => {
      lines.push(...formatItem(item));
    });
  }

  return lines.join('\n');
};

export const formatSuccessMessage = (
  action: 'created' | 'updated',
  itemType: string,
  title: string,
  id: string,
): string => {
  const actionText = action === 'created' ? 'created' : 'updated';
  const prefix =
    action === 'updated' && itemType === 'list'
      ? `Successfully updated ${itemType} to`
      : `Successfully ${actionText} ${itemType}`;
  return `${prefix} "${title}".\n- ID: ${id}`;
};

export const formatDeleteMessage = (
  itemType: string,
  identifier: string,
  options: {
    useQuotes?: boolean;
    useIdPrefix?: boolean;
    usePeriod?: boolean;
    useColon?: boolean;
  } = {},
): string => {
  const {
    useQuotes = true,
    useIdPrefix = true,
    usePeriod = true,
    useColon = true,
  } = options;
  const formattedId = useQuotes ? `"${identifier}"` : identifier;
  let idPart: string;
  if (useIdPrefix) {
    const separator = useColon ? ': ' : ' ';
    idPart = `with ID${separator}${formattedId}`;
  } else {
    idPart = formattedId;
  }
  const period = usePeriod ? '.' : '';
  return `Successfully deleted ${itemType} ${idPart}${period}`;
};
