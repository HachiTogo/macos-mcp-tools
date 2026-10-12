import type { ExecFileException } from "node:child_process"
import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { errorMessage } from "../mcp-result.js"
import { FILE_SYSTEM } from "./constants.js"
import { bufferToString, CliUserError } from "./helpers.js"

// --- Project root discovery ---

function getCurrentModuleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url))
}

function isCorrectProjectRoot(dir: string): boolean {
  const packageJsonPath = path.join(dir, FILE_SYSTEM.PACKAGE_JSON_FILENAME)
  if (!fs.existsSync(packageJsonPath)) {
    return false
  }

  try {
    const packageContent = fs.readFileSync(packageJsonPath, "utf8")
    const packageData = JSON.parse(packageContent)
    return typeof packageData.name === "string" && packageData.name.length > 0
  } catch {
    return false
  }
}

function locateProjectRoot(startDir: string, maxDepth = FILE_SYSTEM.MAX_DIRECTORY_SEARCH_DEPTH): string | undefined {
  let currentDir = startDir
  let depth = 0

  while (depth < maxDepth) {
    if (isCorrectProjectRoot(currentDir)) {
      return currentDir
    }

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) {
      break
    }

    currentDir = parentDir
    depth++
  }

  return undefined
}

export function findProjectRoot(maxDepth = FILE_SYSTEM.MAX_DIRECTORY_SEARCH_DEPTH): string {
  const currentDir = getCurrentModuleDir()
  const root = locateProjectRoot(currentDir, maxDepth)

  if (root) {
    return root
  }

  throw new Error(`Project root not found within ${maxDepth} directory levels`)
}

// --- CLI execution ---

let cachedBinaryPath: string | null = null

const execFilePromise = (cliPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(cliPath, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const execError = error as ExecFileException & {
          stdout?: string | Buffer
          stderr?: string | Buffer
        }
        execError.stdout = stdout
        execError.stderr = stderr
        reject(execError)
        return
      }
      resolve({ stdout, stderr })
    })
  })

interface CliSuccessResponse<T> {
  status: "success"
  result: T
}

interface CliErrorResponse {
  status: "error"
  message: string
  // Set by the Swift CLI on permission failures.
  code?: "permission_denied"
  domain?: PermissionDomain
}

type CliResponse<T> = CliSuccessResponse<T> | CliErrorResponse

export type PermissionDomain = "reminders" | "calendars"

export class CliPermissionError extends Error {
  constructor(
    message: string,
    public readonly domain: PermissionDomain,
  ) {
    super(message)
    this.name = "CliPermissionError"
  }
}

export const parseCliOutput = <T>(output: string): T => {
  let parsed: CliResponse<T>
  try {
    parsed = JSON.parse(output) as CliResponse<T>
  } catch (error) {
    const detail = errorMessage(error)
    throw new Error(`EventKitCLI execution failed: Invalid CLI output - ${detail}`)
  }

  if (parsed.status === "success") {
    return parsed.result
  }

  if (parsed.code === "permission_denied" && (parsed.domain === "calendars" || parsed.domain === "reminders")) {
    throw new CliPermissionError(parsed.message, parsed.domain)
  }

  throw new CliUserError(parsed.message)
}

const runCli = async <T>(cliPath: string, args: string[]): Promise<T> => {
  try {
    const { stdout } = await execFilePromise(cliPath, args)
    const normalized = bufferToString(stdout)
    if (!normalized) {
      throw new Error("EventKitCLI execution failed: Empty CLI output")
    }
    return parseCliOutput(normalized)
  } catch (error) {
    if (error instanceof CliPermissionError || error instanceof CliUserError) {
      throw error
    }
    const execError = error as ExecFileException & {
      stdout?: string | Buffer
    }
    const normalized = bufferToString(execError?.stdout)
    if (normalized) {
      return parseCliOutput(normalized)
    }
    throw new Error(`EventKitCLI execution failed: ${errorMessage(error)}`)
  }
}

export async function executeCli<T>(args: string[]): Promise<T> {
  if (!cachedBinaryPath) {
    const binaryPath = path.join(findProjectRoot(), "bin", FILE_SYSTEM.SWIFT_BINARY_NAME)
    if (!fs.existsSync(binaryPath)) {
      throw new CliUserError(`EventKitCLI binary not found. Searched: ${binaryPath}`)
    }
    cachedBinaryPath = binaryPath
  }
  return await runCli<T>(cachedBinaryPath, args)
}
