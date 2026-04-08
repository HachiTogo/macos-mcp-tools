import { spawnSync } from "node:child_process"

/**
 * Execute a JXA (JavaScript for Automation) script via osascript.
 * Args are passed as a JSON string in argv[0].
 */
export function runJxa(script: string, args: Record<string, unknown> = {}): string {
  const result = spawnSync(
    "osascript",
    ["-l", "JavaScript", "-e", script, "--", JSON.stringify(args)],
    {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || "JXA script failed")
  return result.stdout.trim()
}
