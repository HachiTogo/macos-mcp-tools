import { spawnSync } from "node:child_process"

/** How long one script may run before osascript is killed, so a hung app cannot block the server. */
export const JXA_TIMEOUT_MS = 30_000

/**
 * Execute a JXA (JavaScript for Automation) script via osascript.
 * Args are passed as a JSON string in argv[0]. Output may run to 50 MiB: spawnSync's 1 MiB default
 * failed any script returning a whole message source with ENOBUFS.
 */
export function runJxa(
  script: string,
  args: Record<string, unknown> = {},
  { timeoutMs = JXA_TIMEOUT_MS }: { timeoutMs?: number } = {},
): string {
  const result = spawnSync("osascript", ["-l", "JavaScript", "-e", script, "--", JSON.stringify(args)], {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: timeoutMs,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || "JXA script failed")
  return result.stdout.trim()
}
