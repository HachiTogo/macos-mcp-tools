// `macos-mcp-tools doctor`: checks the things that make these servers fail to start under an
// MCP host, and prints what to do about each. Exit code 1 when anything failed.

import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { accessSync, constants, existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  analyzeHostConfig,
  binaryArchCheck,
  type CheckResult,
  exitCodeFor,
  formatReport,
  PACKAGE_NAME,
  runtimeCheck,
  versionCheck,
} from "./lib/doctor.js"
import { CliPermissionError, executeCli, findProjectRoot } from "./lib/eventkit/index.js"
import { PACKAGE_VERSION } from "./lib/version.js"

const HOME = homedir()
const REGISTRY_TIMEOUT_MS = 5000

const runtime = (): CheckResult => {
  const macos = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout.trim()
  return runtimeCheck(Bun.version, macos, process.arch)
}

const npmLatest = async (): Promise<string | undefined> => {
  try {
    const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}`, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { "dist-tags"?: { latest?: string } }
    return body["dist-tags"]?.latest
  } catch {
    return undefined
  }
}

const eventKitBinaryChecks = (): CheckResult[] => {
  let binaryPath: string
  try {
    binaryPath = join(findProjectRoot(), "bin", "EventKitCLI")
  } catch {
    return [{ name: "EventKitCLI binary", status: "fail", detail: "package root not found from this install" }]
  }
  if (!existsSync(binaryPath)) {
    return [
      {
        name: "EventKitCLI binary",
        status: "fail",
        detail: `${binaryPath} is missing; events and reminders cannot start`,
        fix: "bun run build:swift (requires Xcode Command Line Tools)",
      },
    ]
  }
  try {
    accessSync(binaryPath, constants.X_OK)
  } catch {
    return [
      {
        name: "EventKitCLI binary",
        status: "fail",
        detail: `${binaryPath} is not executable`,
        fix: `chmod +x "${binaryPath}"`,
      },
    ]
  }
  const lipo = spawnSync("lipo", ["-archs", binaryPath], { encoding: "utf8" })
  const archs = lipo.status === 0 ? lipo.stdout.trim().split(/\s+/).filter(Boolean) : undefined
  return [{ name: "EventKitCLI binary", status: "ok", detail: binaryPath }, binaryArchCheck(archs, process.arch)]
}

const fullDiskAccessCheck = (label: string, relativePath: string): CheckResult => {
  const dbPath = join(HOME, relativePath)
  const name = `Full Disk Access (${label})`
  if (!existsSync(dbPath)) {
    return { name, status: "skip", detail: `${dbPath} not found; ${label} may never have been opened on this Mac` }
  }
  try {
    const db = new Database(dbPath, { readonly: true })
    db.query("SELECT 1").get()
    db.close()
    return { name, status: "ok", detail: dbPath }
  } catch (error) {
    return {
      name,
      status: "fail",
      detail: `cannot read ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
      fix: "System Settings > Privacy & Security > Full Disk Access: enable the app that launches the servers (e.g. Claude), then restart it",
    }
  }
}

const eventKitPermissionCheck = async (label: string, action: string): Promise<CheckResult> => {
  const name = `${label} permission`
  try {
    await executeCli<unknown>(["--action", action])
    return { name, status: "ok", detail: "granted to this process" }
  } catch (error) {
    if (error instanceof CliPermissionError) {
      // TCC grants belong to the launching app. A denial here means this terminal lacks access; the
      // MCP host may still hold its own grant, so this is a warning rather than a failure.
      return {
        name,
        status: "warn",
        detail: "denied for processes launched from this terminal; your MCP host has a separate grant",
        fix: `if ${label.toLowerCase()} tools fail inside the host too: System Settings > Privacy & Security > ${label}, enable the host app (e.g. Claude), then restart it`,
      }
    }
    return { name, status: "warn", detail: error instanceof Error ? error.message : String(error) }
  }
}

const toolCheck = (tool: string, purpose: string, install: string): CheckResult => {
  const which = spawnSync("which", [tool], { encoding: "utf8" })
  return which.status === 0
    ? { name: tool, status: "ok", detail: which.stdout.trim() }
    : { name: tool, status: "warn", detail: `not found; ${purpose}`, fix: install }
}

const hostConfigChecks = (label: string, configPath: string): CheckResult[] => {
  if (!existsSync(configPath)) {
    return [{ name: label, status: "skip", detail: `${configPath} not found` }]
  }
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"))
    return analyzeHostConfig(label, config, existsSync)
  } catch (error) {
    return [
      {
        name: label,
        status: "fail",
        detail: `${configPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        fix: "fix the JSON; the host will not start any server until it parses",
      },
    ]
  }
}

export const runDoctor = async (): Promise<number> => {
  const latest = await npmLatest()
  const results: CheckResult[] = [
    runtime(),
    versionCheck(PACKAGE_VERSION, latest),
    ...eventKitBinaryChecks(),
    fullDiskAccessCheck("Mail", "Library/Mail/V10/MailData/Envelope Index"),
    fullDiskAccessCheck("Messages", "Library/Messages/chat.db"),
    await eventKitPermissionCheck("Calendars", "read-calendars"),
    await eventKitPermissionCheck("Reminders", "read-lists"),
    toolCheck("pdftotext", "PDF attachment text extraction will fail", "brew install poppler"),
    ...hostConfigChecks("Claude Desktop", join(HOME, "Library/Application Support/Claude/claude_desktop_config.json")),
    ...hostConfigChecks("Claude Code", join(HOME, ".claude.json")),
  ]

  console.log(`${PACKAGE_NAME} ${PACKAGE_VERSION} doctor\n`)
  console.log(formatReport(results))
  return exitCodeFor(results)
}

if (import.meta.main) {
  process.exit(await runDoctor())
}
