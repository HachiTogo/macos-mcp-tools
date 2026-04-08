import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS === "1"
const RUN_APP_INTEGRATION_TESTS = process.env.RUN_APP_INTEGRATION_TESTS === "1"
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url))

type ServerName = "mail" | "contacts" | "notes" | "tasks" | "memory"

type TestServer = {
  client: Client
  transport: StdioClientTransport
  dataDir: string
  getStderr: () => string
}

const inheritedEnv = (overrides: Record<string, string>): Record<string, string> => {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value
    }
  }

  return { ...env, ...overrides }
}

const startServer = async (serverName: ServerName): Promise<TestServer> => {
  const dataDir = mkdtempSync(join(tmpdir(), `macos-mcp-tools-${serverName}-`))
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", "src/cli.ts", serverName],
    cwd: REPO_ROOT,
    env: inheritedEnv({ MACOS_TOOLS_DATA_DIR: dataDir }),
    stderr: "pipe",
  })
  const client = new Client({ name: `${serverName}-integration-tests`, version: "0.0.1" })
  let stderr = ""

  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk)
  })

  try {
    await client.connect(transport)
  } catch (error) {
    await transport.close().catch(() => undefined)
    rmSync(dataDir, { recursive: true, force: true })
    throw new Error(`Failed to start ${serverName} server: ${error instanceof Error ? error.message : String(error)}\n${stderr}`)
  }

  return { client, transport, dataDir, getStderr: () => stderr }
}

const stopServer = async (server: TestServer | undefined) => {
  if (!server) {
    return
  }

  await server.transport.close().catch(() => undefined)
  rmSync(server.dataDir, { recursive: true, force: true })
}

const getStructuredContent = <T extends Record<string, unknown>>(result: unknown): T => {
  const topLevel = result as { structuredContent?: unknown; toolResult?: unknown }
  const nested = topLevel.toolResult && typeof topLevel.toolResult === "object"
    ? (topLevel.toolResult as { structuredContent?: unknown }).structuredContent
    : undefined
  const structuredContent = topLevel.structuredContent ?? nested

  expect(structuredContent).toBeDefined()
  return structuredContent as T
}

const getTextJsonContent = <T>(result: unknown): T => {
  const payload = result as {
    content?: Array<{ type: string; text?: string }>
    toolResult?: { content?: Array<{ type: string; text?: string }> }
  }
  const content = payload.content ?? payload.toolResult?.content ?? []
  const textBlock = content.find((item) => item.type === "text" && typeof item.text === "string")

  expect(textBlock?.text).toBeDefined()
  return JSON.parse(textBlock!.text as string) as T
}

if (!RUN_INTEGRATION_TESTS) {
  test.skip("integration tests are opt-in; set RUN_INTEGRATION_TESTS=1", () => undefined)
} else {
  describe("tasks server integration", () => {
    let server: TestServer | undefined

    beforeAll(async () => {
      server = await startServer("tasks")
    })

    afterAll(async () => {
      await stopServer(server)
    })

    test("exposes the expected task tools", async () => {
      const result = await server!.client.listTools()
      const toolNames = result.tools.map((tool) => tool.name)

      expect(toolNames).toContain("list_tasks")
      expect(toolNames).toContain("get_task")
      expect(toolNames).toContain("create_task")
      expect(toolNames).toContain("update_task")
      expect(toolNames).toContain("complete_task")
      expect(toolNames).toContain("drop_task")
      expect(toolNames).toContain("reopen_task")
      expect(toolNames).toContain("list_projects")
    })

    test("creates and queries tasks in isolated storage", async () => {
      const created = await server!.client.callTool({
        name: "create_task",
        arguments: {
          name: "Integration task",
          project: "Sandbox",
          tags: ["alpha"],
          flagged: true,
        },
      })
      const createPayload = getStructuredContent<{
        source: string
        task: { id: string; name: string; status: string; project: string | null; tags: string[] }
      }>(created)

      expect(createPayload.source).toBe("task-manager")
      expect(createPayload.task.name).toBe("Integration task")
      expect(createPayload.task.project).toBe("Sandbox")
      expect(createPayload.task.tags).toContain("alpha")
      expect(createPayload.task.tags).toContain("flagged")

      const taskId = createPayload.task.id

      const listed = await server!.client.callTool({
        name: "list_tasks",
        arguments: { project: "Sandbox", status: "active" },
      })
      const listPayload = getStructuredContent<{
        source: string
        tasks: Array<{ id: string; status: string }>
      }>(listed)

      expect(listPayload.source).toBe("task-manager")
      expect(listPayload.tasks.some((task) => task.id === taskId && task.status === "active")).toBe(true)

      const completed = await server!.client.callTool({
        name: "complete_task",
        arguments: { id: taskId },
      })
      const completePayload = getStructuredContent<{
        completed: { id: string; status: string; completedAt: string | null }
      }>(completed)

      expect(completePayload.completed.id).toBe(taskId)
      expect(completePayload.completed.status).toBe("completed")
      expect(typeof completePayload.completed.completedAt).toBe("string")

      const fetched = await server!.client.callTool({
        name: "get_task",
        arguments: { id: taskId },
      })
      const fetchPayload = getStructuredContent<{
        task: { id: string; status: string }
      }>(fetched)

      expect(fetchPayload.task.id).toBe(taskId)
      expect(fetchPayload.task.status).toBe("completed")

      const projects = await server!.client.callTool({
        name: "list_projects",
        arguments: { status: "completed" },
      })
      const projectPayload = getStructuredContent<{
        projects: Array<{ project: string; activeCount: number; completedCount: number }>
      }>(projects)
      const sandboxProject = projectPayload.projects.find((project) => project.project === "Sandbox")

      expect(sandboxProject).toBeDefined()
      expect((sandboxProject?.completedCount ?? 0) >= 1).toBe(true)
    })
  })

  describe("memory server integration", () => {
    let server: TestServer | undefined

    beforeAll(async () => {
      server = await startServer("memory")
    })

    afterAll(async () => {
      await stopServer(server)
    })

    test("exposes the expected memory tools", async () => {
      const result = await server!.client.listTools()
      const toolNames = result.tools.map((tool) => tool.name)

      expect(toolNames).toContain("create_entry")
      expect(toolNames).toContain("update_entry")
      expect(toolNames).toContain("get_entry")
      expect(toolNames).toContain("search_entries")
      expect(toolNames).toContain("query_last_occurrence")
      expect(toolNames).toContain("query_duration_since")
    })

    test("creates and queries memory entries in isolated storage", async () => {
      const created = await server!.client.callTool({
        name: "create_entry",
        arguments: {
          kind: "memory",
          title: "Integration entry",
          subject: "integration-subject",
          action: "did",
          object: "integration-object",
          body: "Created by the opt-in integration test suite.",
          happened_at: "2024-01-01T00:00:00.000Z",
          aliases: ["integration alias"],
        },
      })
      const createPayload = getStructuredContent<{
        source: string
        entry: { id: string; title: string | null; aliases: string[] }
      }>(created)

      expect(createPayload.source).toBe("sqlite-memory")
      expect(createPayload.entry.title).toBe("Integration entry")
      expect(createPayload.entry.aliases).toContain("integration alias")

      const entryId = createPayload.entry.id

      const fetched = await server!.client.callTool({
        name: "get_entry",
        arguments: { id: entryId },
      })
      const fetchPayload = getStructuredContent<{
        entry: { id: string; subject: string | null; action: string | null; object: string | null }
      }>(fetched)

      expect(fetchPayload.entry.id).toBe(entryId)
      expect(fetchPayload.entry.subject).toBe("integration-subject")
      expect(fetchPayload.entry.action).toBe("did")
      expect(fetchPayload.entry.object).toBe("integration-object")

      const searched = await server!.client.callTool({
        name: "search_entries",
        arguments: { subject: "integration-subject", action: "did", limit: 5 },
      })
      const searchPayload = getStructuredContent<{
        entries: Array<{ id: string }>
      }>(searched)

      expect(searchPayload.entries.some((entry) => entry.id === entryId)).toBe(true)

      const lastOccurrence = await server!.client.callTool({
        name: "query_last_occurrence",
        arguments: {
          subject: "integration-subject",
          action: "did",
          object: "integration-object",
        },
      })
      const lastOccurrencePayload = getStructuredContent<{
        status: string
        entry: { id: string }
        timestamp: string
      }>(lastOccurrence)

      expect(lastOccurrencePayload.status).toBe("matched")
      expect(lastOccurrencePayload.entry.id).toBe(entryId)
      expect(lastOccurrencePayload.timestamp).toBe("2024-01-01T00:00:00.000Z")

      const duration = await server!.client.callTool({
        name: "query_duration_since",
        arguments: {
          subject: "integration-subject",
          action: "did",
          object: "integration-object",
        },
      })
      const durationPayload = getStructuredContent<{
        status: string
        entry: { id: string }
        elapsed_days: number
        elapsed_hours: number
      }>(duration)

      expect(durationPayload.status).toBe("matched")
      expect(durationPayload.entry.id).toBe(entryId)
      expect(durationPayload.elapsed_days).toBeGreaterThanOrEqual(0)
      expect(durationPayload.elapsed_hours).toBeGreaterThanOrEqual(0)
    })
  })

  const appDescribe = RUN_APP_INTEGRATION_TESTS ? describe : describe.skip

  appDescribe("live macOS app smoke tests", () => {
    let mailServer: TestServer | undefined
    let contactsServer: TestServer | undefined
    let notesServer: TestServer | undefined

    beforeAll(async () => {
      mailServer = await startServer("mail")
      contactsServer = await startServer("contacts")
      notesServer = await startServer("notes")
    })

    afterAll(async () => {
      await stopServer(mailServer)
      await stopServer(contactsServer)
      await stopServer(notesServer)
    })

    test("mail unread_emails returns a readable result shape", async () => {
      const unread = await mailServer!.client.callTool({
        name: "unread_emails",
        arguments: { limit: 100 },
      })
      const payload = getStructuredContent<{
        source: string
        query: { limit: number }
        messages: Array<Record<string, unknown>>
      }>(unread)

      expect(typeof payload.source).toBe("string")
      expect(payload.query.limit).toBe(100)
      expect(Array.isArray(payload.messages)).toBe(true)

      const unreadCount = payload.messages.length
      expect(unreadCount).toBeGreaterThanOrEqual(0)
    })

    test("contacts_people read returns a total count", async () => {
      const contacts = await contactsServer!.client.callTool({
        name: "contacts_people",
        arguments: { action: "read", limit: 1, offset: 0 },
      })
      const payload = getTextJsonContent<{
        contacts: Array<Record<string, unknown>>
        total: number
        offset: number
        limit: number
      }>(contacts)

      expect(Array.isArray(payload.contacts)).toBe(true)
      expect(payload.total).toBeGreaterThanOrEqual(0)
      expect(payload.offset).toBe(0)
      expect(payload.limit).toBe(1)
    })

    test("notes folders expose a computed total note count", async () => {
      const folders = await notesServer!.client.callTool({
        name: "list_folders",
        arguments: {},
      })
      const payload = getTextJsonContent<Array<{ name: string; noteCount: number }>>(folders)

      expect(Array.isArray(payload)).toBe(true)

      const noteCount = payload.reduce((sum, folder) => sum + folder.noteCount, 0)
      expect(noteCount).toBeGreaterThanOrEqual(0)

      const firstFolder = payload[0]
      if (firstFolder) {
        const notes = await notesServer!.client.callTool({
          name: "list_notes",
          arguments: { folder: firstFolder.name, limit: 1, offset: 0 },
        })
        const notesPayload = getTextJsonContent<{
          notes: Array<Record<string, unknown>>
          total: number
          offset: number
          limit: number
        }>(notes)

        expect(Array.isArray(notesPayload.notes)).toBe(true)
        expect(notesPayload.total).toBeGreaterThanOrEqual(0)
      }
    })
  })
}
