import { existsSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { Database } from "bun:sqlite"

// ── Types ──────────────────────────────────────────────────────────────

type TaskStatus = "active" | "completed" | "dropped"

type RepeatRule = {
  intervalDays: number
  from: "completion" | "due"
}

type TaskRow = {
  id: string
  name: string
  note: string | null
  status: TaskStatus
  project: string | null
  tags: string
  due_date: string | null
  repeat_rule: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

type Task = {
  id: string
  name: string
  note: string | null
  status: TaskStatus
  project: string | null
  tags: string[]
  dueDate: string | null
  repeatRule: RepeatRule | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

// ── Constants ──────────────────────────────────────────────────────────

// Data directory: env var > .opencode/data (if exists) > ~/.local/share/macos-tools/
function resolveDataDir(): string {
  if (process.env.MACOS_TOOLS_DATA_DIR) {
    const dir = resolve(process.env.MACOS_TOOLS_DATA_DIR)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  // Check for .opencode/data relative to cwd (opencode workspace)
  const opencodeDir = resolve(".opencode/data")
  if (existsSync(opencodeDir)) {
    return opencodeDir
  }
  // Default
  const defaultDir = join(homedir(), ".local", "share", "macos-tools")
  mkdirSync(defaultDir, { recursive: true })
  return defaultDir
}

const DATA_DIR = resolveDataDir()
const DB_PATH = join(DATA_DIR, "tasks.db")
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const TASK_STATUSES = ["active", "completed", "dropped"] as const satisfies readonly TaskStatus[]
const REPEAT_FROM_VALUES = ["completion", "due"] as const
const SOURCE_NAME = "task-manager"

// ── Database ───────────────────────────────────────────────────────────

let database: Database | undefined

const ensureSchema = (db: Database) => {
  db.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      note          TEXT,
      status        TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('active','completed','dropped')),
      project       TEXT,
      tags          TEXT NOT NULL DEFAULT '[]',
      due_date      TEXT,
      repeat_rule   TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      completed_at  TEXT
    )
  `).run()
  db.query("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)").run()
  db.query("CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project)").run()
  db.query("CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date)").run()
}

const getDatabase = () => {
  if (database) {
    return database
  }

  database = new Database(DB_PATH)
  ensureSchema(database)
  return database
}

const withTransaction = <T>(callback: (db: Database) => T) => {
  const db = getDatabase()
  db.query("BEGIN").run()

  try {
    const result = callback(db)
    db.query("COMMIT").run()
    return result
  } catch (error) {
    try {
      db.query("ROLLBACK").run()
    } catch {
      // ignore rollback failure
    }

    throw error
  }
}

// ── Row ↔ Task conversion ──────────────────────────────────────────────

const rowToTask = (row: TaskRow): Task => ({
  id: row.id,
  name: row.name,
  note: row.note,
  status: row.status,
  project: row.project,
  tags: JSON.parse(row.tags) as string[],
  dueDate: row.due_date,
  repeatRule: row.repeat_rule ? (() => {
    const raw = JSON.parse(row.repeat_rule) as { interval_days: number; from: "completion" | "due" }
    return { intervalDays: raw.interval_days, from: raw.from } satisfies RepeatRule
  })() : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
})

// ── Tag helpers ────────────────────────────────────────────────────────

const applyFlaggedToTags = (tags: string[], flagged: boolean | undefined): string[] => {
  if (flagged === undefined) {
    return tags
  }

  const filtered = tags.filter((t) => t !== "flagged")

  if (flagged) {
    filtered.push("flagged")
  }

  return filtered
}

// ── Database operations ────────────────────────────────────────────────

const getTaskById = (db: Database, id: string): Task | null => {
  const row = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null

  if (!row) {
    return null
  }

  return rowToTask(row)
}

const formatToolResult = (payload: Record<string, unknown>) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(payload, null, 2),
    },
  ],
  structuredContent: payload,
})

const formatNotFoundResult = (id: string) => ({
  content: [
    {
      type: "text" as const,
      text: `Task not found: ${id}`,
    },
  ],
  structuredContent: {
    source: SOURCE_NAME,
    task: null,
  },
  isError: true,
})

// ── Tool implementations ───────────────────────────────────────────────

const handleListTasks = (args: {
  status?: TaskStatus
  project?: string
  tag?: string
  dueBefore?: string
  dueAfter?: string
  flagged?: boolean
  limit: number
}) => {
  const db = getDatabase()
  const whereClauses: string[] = []
  const values: (string | number)[] = []

  // Default to active if no status filter
  const status = args.status ?? "active"
  whereClauses.push("status = ?")
  values.push(status)

  if (args.project !== undefined) {
    whereClauses.push("(project = ? OR project LIKE ? || '/%')")
    values.push(args.project, args.project)
  }

  if (args.dueBefore !== undefined) {
    whereClauses.push("due_date IS NOT NULL AND due_date <= ?")
    values.push(args.dueBefore)
  }

  if (args.dueAfter !== undefined) {
    whereClauses.push("due_date IS NOT NULL AND due_date >= ?")
    values.push(args.dueAfter)
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : ""
  const rows = db
    .query(
      `SELECT * FROM tasks ${whereSql} ORDER BY CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC, created_at ASC LIMIT ?`,
    )
    .all(...values, args.limit) as TaskRow[]

  let tasks = rows.map(rowToTask)

  // App-level tag filtering
  if (args.tag !== undefined) {
    tasks = tasks.filter((t) => t.tags.includes(args.tag!))
  }

  if (args.flagged === true) {
    tasks = tasks.filter((t) => t.tags.includes("flagged"))
  }

  return formatToolResult({
    source: SOURCE_NAME,
    tasks,
  })
}

const handleGetTask = (args: { id: string }) => {
  const task = getTaskById(getDatabase(), args.id)

  if (!task) {
    return formatNotFoundResult(args.id)
  }

  return formatToolResult({
    source: SOURCE_NAME,
    task,
  })
}

const handleCreateTask = (args: {
  name: string
  note?: string
  project?: string
  tags?: string[]
  dueDate?: string
  repeatRule?: RepeatRule
  flagged?: boolean
}) => {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const tags = applyFlaggedToTags(args.tags ?? [], args.flagged)
  const repeatRule = args.repeatRule
    ? JSON.stringify({ interval_days: args.repeatRule.intervalDays, from: args.repeatRule.from })
    : null

  return withTransaction((db) => {
    db.query(
      `INSERT INTO tasks (id, name, note, status, project, tags, due_date, repeat_rule, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      id,
      args.name,
      args.note ?? null,
      args.project ?? null,
      JSON.stringify(tags),
      args.dueDate ?? null,
      repeatRule,
      now,
      now,
    )

    const task = getTaskById(db, id)

    if (!task) {
      throw new Error(`Task not found after create: ${id}`)
    }

    return formatToolResult({
      source: SOURCE_NAME,
      task,
    })
  })
}

const handleUpdateTask = (args: {
  id: string
  name?: string
  note?: string | null
  project?: string | null
  tags?: string[]
  dueDate?: string | null
  repeatRule?: RepeatRule | null
  flagged?: boolean
}) => {
  return withTransaction((db) => {
    const existing = getTaskById(db, args.id)

    if (!existing) {
      return formatNotFoundResult(args.id)
    }

    const updates: string[] = []
    const values: (string | null)[] = []

    const addUpdate = (field: string, value: string | null) => {
      updates.push(`${field} = ?`)
      values.push(value)
    }

    if (args.name !== undefined) {
      addUpdate("name", args.name)
    }

    if (args.note !== undefined) {
      addUpdate("note", args.note)
    }

    if (args.project !== undefined) {
      addUpdate("project", args.project)
    }

    if (args.dueDate !== undefined) {
      addUpdate("due_date", args.dueDate)
    }

    if (args.repeatRule !== undefined) {
      if (args.repeatRule === null) {
        addUpdate("repeat_rule", null)
      } else {
        addUpdate(
          "repeat_rule",
          JSON.stringify({
            interval_days: args.repeatRule.intervalDays,
            from: args.repeatRule.from,
          }),
        )
      }
    }

    // Resolve tags: start from provided tags or existing, then apply flagged
    if (args.tags !== undefined || args.flagged !== undefined) {
      const baseTags = args.tags !== undefined ? args.tags : existing.tags
      const finalTags = applyFlaggedToTags(baseTags, args.flagged)
      addUpdate("tags", JSON.stringify(finalTags))
    }

    if (updates.length > 0) {
      updates.push("updated_at = ?")
      values.push(new Date().toISOString())
      values.push(args.id)
      db.query(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`).run(...values)
    }

    const task = getTaskById(db, args.id)

    return formatToolResult({
      source: SOURCE_NAME,
      task,
    })
  })
}

const handleCompleteTask = (args: { id: string }) => {
  return withTransaction((db) => {
    const existing = getTaskById(db, args.id)

    if (!existing) {
      return formatNotFoundResult(args.id)
    }

    const now = new Date().toISOString()

    db.query(
      "UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?",
    ).run(now, now, args.id)

    const completed = getTaskById(db, args.id)!

    // Handle repeat logic
    let next: Task | null = null

    // Read repeat_rule from the row directly to get the raw DB value
    const row = db.query("SELECT repeat_rule, due_date FROM tasks WHERE id = ?").get(args.id) as {
      repeat_rule: string | null
      due_date: string | null
    } | null

    if (row?.repeat_rule) {
      const rule = JSON.parse(row.repeat_rule) as { interval_days: number; from: string }
      const intervalMs = rule.interval_days * 24 * 60 * 60 * 1000
      let newDueDate: string

      if (rule.from === "due" && row.due_date) {
        const oldDue = new Date(row.due_date)
        newDueDate = new Date(oldDue.getTime() + intervalMs).toISOString()
      } else {
        // from === "completion" or due_date was null
        newDueDate = new Date(new Date(now).getTime() + intervalMs).toISOString()
      }

      const nextId = crypto.randomUUID()
      const nextNow = new Date().toISOString()

      db.query(
        `INSERT INTO tasks (id, name, note, status, project, tags, due_date, repeat_rule, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        nextId,
        existing.name,
        existing.note,
        existing.project,
        JSON.stringify(existing.tags),
        newDueDate,
        row.repeat_rule,
        nextNow,
        nextNow,
      )

      next = getTaskById(db, nextId)
    }

    return formatToolResult({
      source: SOURCE_NAME,
      completed,
      next,
    })
  })
}

const handleDropTask = (args: { id: string }) => {
  return withTransaction((db) => {
    const existing = getTaskById(db, args.id)

    if (!existing) {
      return formatNotFoundResult(args.id)
    }

    const now = new Date().toISOString()
    db.query("UPDATE tasks SET status = 'dropped', updated_at = ? WHERE id = ?").run(now, args.id)

    const task = getTaskById(db, args.id)

    return formatToolResult({
      source: SOURCE_NAME,
      task,
    })
  })
}

const handleReopenTask = (args: { id: string }) => {
  return withTransaction((db) => {
    const existing = getTaskById(db, args.id)

    if (!existing) {
      return formatNotFoundResult(args.id)
    }

    const now = new Date().toISOString()
    db.query(
      "UPDATE tasks SET status = 'active', completed_at = NULL, updated_at = ? WHERE id = ?",
    ).run(now, args.id)

    const task = getTaskById(db, args.id)

    return formatToolResult({
      source: SOURCE_NAME,
      task,
    })
  })
}

const handleListProjects = (args: { status?: TaskStatus }) => {
  const db = getDatabase()

  let rows: Array<{ project: string; activeCount: number; completedCount: number }>

  if (args.status !== undefined) {
    // Filter to projects that have at least one task with the given status
    rows = db
      .query(
        `SELECT
           project,
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS activeCount,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedCount
         FROM tasks
         WHERE project IS NOT NULL
         GROUP BY project
         HAVING SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) > 0
         ORDER BY project ASC`,
      )
      .all(args.status) as Array<{ project: string; activeCount: number; completedCount: number }>
  } else {
    // Default: only projects with at least one active task
    rows = db
      .query(
        `SELECT
           project,
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS activeCount,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedCount
         FROM tasks
         WHERE project IS NOT NULL
         GROUP BY project
         HAVING SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) > 0
         ORDER BY project ASC`,
      )
      .all() as Array<{ project: string; activeCount: number; completedCount: number }>
  }

  return formatToolResult({
    source: SOURCE_NAME,
    projects: rows.map((r) => ({
      project: r.project,
      activeCount: Number(r.activeCount),
      completedCount: Number(r.completedCount),
    })),
  })
}

// ── MCP Server ─────────────────────────────────────────────────────────

const server = new McpServer({ name: "task-manager", version: "0.0.1" })

server.registerTool(
  "list_tasks",
  {
    description:
      "List tasks with optional filters. Returns task id, name, status, project, dates, tags, and repeat rule.",
    inputSchema: {
      status: z.enum(TASK_STATUSES).optional().describe("Filter by status"),
      project: z.string().optional().describe('Exact project name or prefix (e.g. "Home" matches all Home/* projects)'),
      tag: z.string().optional().describe("Filter by tag"),
      dueBefore: z.string().optional().describe("ISO-8601 date-time upper bound for due_date"),
      dueAfter: z.string().optional().describe("ISO-8601 date-time lower bound for due_date"),
      flagged: z.boolean().optional().describe("Filter to flagged tasks only"),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).optional().describe("Max tasks to return"),
    },
  },
  async (args) => {
    try {
      const result = handleListTasks({
        ...args,
        limit: args.limit ?? DEFAULT_LIMIT,
      })
      return result
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }
    }
  },
)

server.registerTool(
  "get_task",
  {
    description: "Get detailed information about a specific task by its ID.",
    inputSchema: {
      id: z.string().describe("Task ID"),
    },
  },
  async (args) => {
    try {
      return handleGetTask(args)
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }
    }
  },
)

server.registerTool(
  "create_task",
  {
    description:
      "Create a new task. By default it has no project; specify a project name to organize it.",
    inputSchema: {
      name: z.string().describe("Task name"),
      note: z.string().optional().describe("Additional notes"),
      project: z.string().optional().describe("Project name"),
      tags: z.array(z.string()).optional().describe("Tags to apply"),
      dueDate: z.string().optional().describe("ISO-8601 due date"),
      repeatRule: z.object({
        intervalDays: z.number().int().min(1),
        from: z.enum(REPEAT_FROM_VALUES),
      }).optional().describe("Repeat rule"),
      flagged: z.boolean().optional().describe("Mark as flagged"),
    },
  },
  async (args) => {
    try {
      return handleCreateTask(args)
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }
    }
  },
)

server.registerTool(
  "update_task",
  {
    description: "Update an existing task. Only specified fields are changed.",
    inputSchema: {
      id: z.string().describe("Task ID"),
      name: z.string().optional().describe("New task name"),
      note: z.union([z.string(), z.null()]).optional().describe("New note (null to clear)"),
      project: z.union([z.string(), z.null()]).optional().describe("New project (null to clear)"),
      tags: z.array(z.string()).optional().describe("Replace tags"),
      dueDate: z.union([z.string(), z.null()]).optional().describe("New due date (null to clear)"),
      repeatRule: z.union([
        z.object({
          intervalDays: z.number().int().min(1),
          from: z.enum(REPEAT_FROM_VALUES),
        }),
        z.null(),
      ]).optional().describe("New repeat rule (null to clear)"),
      flagged: z.boolean().optional().describe("Set flagged state"),
    },
  },
  async (args) => {
    try {
      return handleUpdateTask(args)
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }
    }
  },
)

server.registerTool(
  "complete_task",
  {
    description:
      "Mark a task complete by its ID. If the task has a repeat rule, a new active task is created with the next due date.",
    inputSchema: {
      id: z.string().describe("Task ID"),
    },
  },
  async (args) => {
    try {
      return handleCompleteTask(args)
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }
    }
  },
)

server.registerTool(
  "drop_task",
  {
    description: "Drop a task by its ID (mark as dropped).",
    inputSchema: {
      id: z.string().describe("Task ID"),
    },
  },
  async (args) => {
    try {
      return handleDropTask(args)
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }
    }
  },
)

server.registerTool(
  "reopen_task",
  {
    description: "Reopen a completed or dropped task by its ID (mark as active).",
    inputSchema: {
      id: z.string().describe("Task ID"),
    },
  },
  async (args) => {
    try {
      return handleReopenTask(args)
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }
    }
  },
)

server.registerTool(
  "list_projects",
  {
    description:
      "List distinct projects with active and completed task counts. By default only projects with at least one active task.",
    inputSchema: {
      status: z.enum(TASK_STATUSES).optional().describe("Filter to projects with at least one task of this status"),
    },
  },
  async (args) => {
    try {
      return handleListProjects(args)
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }
    }
  },
)

// ── Entry point ────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
